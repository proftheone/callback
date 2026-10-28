'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv(path.join(__dirname, '..', '.env'));

const { db, sites, leads, stats, trackEvent, accounts, sessions, loginLinks, publicAccount } = require('./db');
const { isOpen, availableSlots } = require('./hours');
const tel = require('./telephony');
const { buildPluginZip } = require('./plugin-zip');
const mailer = require('./mailer');

const PORT = Number(process.env.PORT || 3000);
// Bez ustawionego hasła właściciela losujemy jednorazowe, zamiast przyjmować „admin”.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- pomocnicze ----------

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
};

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

const twiml = (res, body) => send(res, 200, body, { 'content-type': 'text/xml; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // nadmiar tylko odczytujemy i wyrzucamy, żeby klient dostał czytelny błąd 413
      if (size > 64 * 1024) { const e = new Error('too large'); e.status = 413; reject(e); } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(raw ? JSON.parse(raw) : {});
        else if (type.includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(raw)));
        else resolve(raw ? JSON.parse(raw) : {});
      } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function normalizePhone(input, defaultCc = '48') {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = p.length === 9 ? `+${defaultCc}${p}` : `+${p}`;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

// Render stoi za Cloudflare, który nadpisuje te nagłówki prawdziwym IP klienta.
// X-Forwarded-For klient może podrobić, więc go nie używamy.
function clientIp(req) {
  return String(req.headers['true-client-ip'] || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').trim();
}

// Do bazy i panelu trafiają tylko adresy http(s), żeby link „javascript:” nie wykonał kodu w panelu.
function httpUrl(v, max = 500) {
  const s = String(v || '').trim().slice(0, max);
  return /^https?:\/\//i.test(s) ? s : '';
}

const SETTING_RULES = {
  color: (v) => /^#[0-9a-f]{3,8}$/i.test(v),
  theme: (v) => v === 'dark' || v === 'light',
  position: (v) => v === 'left' || v === 'right',
  avatarUrl: (v) => v === '' || /^https?:\/\/[^\s"'<>]+$/i.test(v),
  webhookUrl: (v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v),
  notifyEmail: (v) => v.split(',').map((e) => e.trim()).filter(Boolean).every((e) => validEmail(e)),
};
function invalidSetting(settings) {
  if (!settings || typeof settings !== 'object') return null;
  for (const [k, rule] of Object.entries(SETTING_RULES)) if (settings[k] !== undefined && !rule(String(settings[k]))) return k;
  return null;
}

function originAllowed(req, site) {
  if (!site.domain) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return site.domain.split(',').map((d) => d.trim()).filter(Boolean)
      .some((d) => host === d || host.endsWith('.' + d) || host === 'localhost');
  } catch { return false; }
}

function isAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const headers = { ...SECURITY_HEADERS, 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (rel === '/widget.js') Object.assign(headers, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

// Ustawienia, które widzi widget (bez numeru konsultanta, webhooka itp.).
function publicConfig(site) {
  const s = site.settings;
  const open = isOpen(s);
  return {
    open,
    color: s.color, theme: s.theme, position: s.position,
    title: s.title, subtitle: s.subtitle, buttonText: s.buttonText,
    offHoursTitle: s.offHoursTitle, offHoursSubtitle: s.offHoursSubtitle,
    thankYou: s.thankYou, thankYouScheduled: s.thankYouScheduled,
    liveCall: s.liveCall, thankYouQueued: s.thankYouQueued,
    autoOpenSeconds: s.autoOpenSeconds, exitIntent: s.exitIntent, exitIntentTitle: s.exitIntentTitle,
    teaser: s.teaser, teaserDelay: s.teaserDelay, teaserGreeting: s.teaserGreeting, teaserText: s.teaserText,
    avatarUrl: s.avatarUrl,
    slots: availableSlots(s, { days: 7 }).slice(0, 80),
  };
}

// ---------- routing ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

route('GET', '/health', (req, res) => send(res, 200, { ok: true }));

// --- widget (publiczne) ---
route('GET', '/api/widget/:key/config', (req, res, { key }) => {
  const site = sites.byKey(key);
  if (!site) return send(res, 404, { error: 'Nieznana strona' }, CORS);
  send(res, 200, publicConfig(site), { ...CORS, 'cache-control': 'no-store' });
});

route('POST', '/api/widget/:key/event', async (req, res, { key }) => {
  const site = sites.byKey(key);
  const { type } = await readBody(req);
  if (site && ['view', 'open', 'exit_intent'].includes(type)) trackEvent(site.id, type);
  send(res, 204, '', CORS);
});

route('POST', '/api/widget/:key/callback', async (req, res, { key }) => {
  const site = sites.byKey(key);
  if (!site) return send(res, 404, { error: 'Nieznana strona' }, CORS);
  if (!originAllowed(req, site)) return send(res, 403, { error: 'Niedozwolona domena' }, CORS);
  const b = await readBody(req);
  if (b.website) return send(res, 200, { ok: true }, CORS); // honeypot na boty
  const phone = normalizePhone(b.phone);
  if (!phone) return send(res, 400, { error: 'Podaj poprawny numer telefonu' }, CORS);
  const ip = clientIp(req);
  if (leads.recentFromIp(ip, 10) >= 3) return send(res, 429, { error: 'Zbyt wiele próśb. Spróbuj za kilka minut.' }, CORS);

  let scheduledAt = null;
  if (b.scheduledAt) {
    const d = new Date(b.scheduledAt);
    if (isNaN(d) || !isOpen(site.settings, d)) return send(res, 400, { error: 'Wybierz termin w godzinach pracy' }, CORS);
    scheduledAt = d.toISOString();
  }
  const open = isOpen(site.settings);
  if (!scheduledAt && !open) scheduledAt = availableSlots(site.settings, { days: 7 })[0]?.at || null;

  const lead = leads.create(site.id, {
    phone,
    name: String(b.name || '').slice(0, 100) || null,
    status: scheduledAt ? 'scheduled' : 'new',
    scheduled_at: scheduledAt,
    page_url: httpUrl(b.pageUrl),
    referrer: httpUrl(b.referrer),
    utm_source: String(b.utm_source || '').slice(0, 100),
    utm_medium: String(b.utm_medium || '').slice(0, 100),
    utm_campaign: String(b.utm_campaign || '').slice(0, 100),
    trigger: ['button', 'auto', 'exit_intent'].includes(b.trigger) ? b.trigger : 'button',
    ip,
  });
  tel.notifyWebhook(site, lead, 'lead.created');
  notifyLeadEmail(site, lead, req);
  // po przekroczeniu limitu planu lead jest zapisywany, ale system nie dzwoni automatycznie
  if (site.account_id) {
    const acc = accounts.byId(site.account_id);
    const limit = PLANS[acc.plan]?.leadsPerMonth;
    if (limit && usage(acc.id).leadsThisMonth > limit) {
      leads.update(lead.id, { status: 'new', scheduled_at: null, notes: 'Przekroczony miesięczny limit leadów w planie. Zadzwoń ręcznie lub zmień plan.' });
      return send(res, 200, { ok: true, scheduled: !!scheduledAt, scheduledAt }, CORS);
    }
  }
  if (!scheduledAt) tel.startCall(lead, site);
  send(res, 200, { ok: true, scheduled: !!scheduledAt, scheduledAt }, CORS);
});

// --- Twilio webhooki ---
async function twilioCtx(req, res, url) {
  const p = await readBody(req);
  const full = (tel.PUBLIC_URL || `http://${req.headers.host}`) + url.pathname + url.search;
  if (!tel.validSignature(full, p, req.headers['x-twilio-signature'])) { send(res, 403, 'bad signature'); return null; }
  const lead = leads.byId(Number(url.searchParams.get('lead')));
  if (!lead) { twiml(res, '<Response><Hangup/></Response>'); return null; }
  return { p, lead, site: sites.byId(lead.site_id) };
}

route('POST', '/twilio/agent-answer', async (req, res, _, url) => {
  const c = await twilioCtx(req, res, url); if (!c) return;
  twiml(res, tel.agentAnswerTwiml(c.lead, c.site));
});
route('POST', '/twilio/dial-done', async (req, res, _, url) => {
  const c = await twilioCtx(req, res, url); if (!c) return;
  twiml(res, tel.dialDone(c.lead, c.site, c.p));
});
route('POST', '/twilio/status', async (req, res, _, url) => {
  const c = await twilioCtx(req, res, url); if (!c) return;
  tel.callStatus(c.lead, c.site, c.p);
  send(res, 204, '');
});
route('POST', '/twilio/recording', async (req, res, _, url) => {
  const c = await twilioCtx(req, res, url); if (!c) return;
  tel.recording(c.lead, c.p);
  send(res, 204, '');
});

// --- konta klientów ---
const PLANS = {
  free: { name: 'Start', sites: 1, leadsPerMonth: 50 },
  pro: { name: 'Pro', sites: 3, leadsPerMonth: 500 },
  business: { name: 'Business', sites: 20, leadsPerMonth: null },
};

const authAttempts = new Map();
function authLimited(ip) {
  const now = Date.now();
  const list = (authAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  list.push(now);
  authAttempts.set(ip, list);
  return list.length > 20;
}

function validEmail(e) { return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(e || ''); }

// E-mail o nowym zgłoszeniu: do adresów ze strony (domyślnie e-mail konta klienta)
// oraz kopia dla właściciela platformy z LEAD_NOTIFY_EMAIL.
function leadRecipients(site) {
  const own = String(site.settings.notifyEmail || '').split(',').map((e) => e.trim()).filter(validEmail);
  if (!own.length && site.account_id) {
    const acc = accounts.byId(site.account_id);
    if (acc && validEmail(acc.email)) own.push(acc.email);
  }
  const copy = String(process.env.LEAD_NOTIFY_EMAIL || '').split(',').map((e) => e.trim()).filter(validEmail);
  return [...new Set([...own, ...copy].map((e) => e.toLowerCase()))];
}

function notifyLeadEmail(site, lead, req) {
  if (!mailer.enabled()) return;
  const to = leadRecipients(site);
  if (!to.length) return;
  const h = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = new Date().toLocaleString('pl-PL', { timeZone: site.settings.timezone || 'Europe/Warsaw' });
  const planned = lead.scheduled_at ? new Date(lead.scheduled_at).toLocaleString('pl-PL', { timeZone: site.settings.timezone || 'Europe/Warsaw' }) : '';
  const source = lead.utm_source || (lead.referrer ? lead.referrer : 'wejście bezpośrednie');
  const panelUrl = `${publicBase(req)}${site.account_id ? '/app/' : '/admin/'}`;
  const rows = [
    ['Telefon', lead.phone],
    ['Strona', site.name],
    ['Kiedy', when],
    ...(planned ? [['Prosi o kontakt', planned]] : []),
    ['Podstrona', lead.page_url || '—'],
    ['Źródło', source + (lead.utm_campaign ? ` / ${lead.utm_campaign}` : '')],
  ];
  const text = `Nowe zgłoszenie z widgetu Callback.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nPanel: ${panelUrl}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">` +
    `<h2 style="margin:0 0 12px">Nowe zgłoszenie: <a href="tel:${h(lead.phone)}" style="color:#7C3AED">${h(lead.phone)}</a></h2>` +
    `<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#666">${h(k)}</td><td><b>${h(v)}</b></td></tr>`).join('')}</table>` +
    `<p style="margin-top:18px"><a href="${h(panelUrl)}" style="background:#7C3AED;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Otwórz panel</a></p></div>`;
  mailer.sendMail({ to, subject: `Nowy lead: ${lead.phone} (${site.name})`, text, html })
    .catch((e) => console.warn('[e-mail]', e.message));
}

route('POST', '/api/auth/register', async (req, res) => {
  if (authLimited(clientIp(req))) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za kilka minut.' });
  const b = await readBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return send(res, 400, { error: 'Podaj poprawny adres e-mail' });
  if (String(b.password || '').length < 8) return send(res, 400, { error: 'Hasło musi mieć co najmniej 8 znaków' });
  if (accounts.byEmail(email)) return send(res, 409, { error: 'Konto z tym adresem już istnieje' });
  const acc = accounts.create({ email, password: b.password, company: String(b.company || '').slice(0, 120) });
  const domain = String(b.website || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  if (domain) sites.create({ name: domain, domain, account_id: acc.id });
  send(res, 201, { token: sessions.create(acc.id), account: publicAccount(acc) });
});

route('POST', '/api/auth/login', async (req, res) => {
  if (authLimited(clientIp(req))) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za kilka minut.' });
  const b = await readBody(req);
  const acc = accounts.verify(String(b.email || '').trim().toLowerCase(), String(b.password || ''));
  if (!acc) return send(res, 401, { error: 'Nieprawidłowy e-mail lub hasło' });
  send(res, 200, { token: sessions.create(acc.id), account: publicAccount(acc) });
});

// Logowanie jednorazowym linkiem (z wtyczki WordPress).
route('POST', '/api/auth/exchange', async (req, res) => {
  const b = await readBody(req);
  const accountId = loginLinks.consume(b.token);
  if (!accountId) return send(res, 401, { error: 'Link logowania wygasł. Kliknij „Otwórz panel” we WordPressie jeszcze raz.' });
  send(res, 200, { token: sessions.create(accountId), account: publicAccount(accounts.byId(accountId)) });
});

// --- wtyczka WordPress: instalacja jednym kliknięciem ---
// Wtyczka wysyła e-mail, telefon konsultanta i adres strony. Zakładamy konto (jeśli trzeba) i stronę,
// a wtyczka dostaje klucz widgetu i sekret do późniejszego logowania do panelu.
route('POST', '/api/wp/connect', async (req, res) => {
  if (authLimited(clientIp(req))) return send(res, 429, { error: 'Zbyt wiele prób. Spróbuj za kilka minut.' });
  const b = await readBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return send(res, 400, { error: 'Podaj poprawny adres e-mail' });
  const phone = normalizePhone(b.phone);
  if (!phone) return send(res, 400, { error: 'Podaj poprawny numer telefonu, na który mamy dzwonić' });
  let domain = '';
  try { domain = new URL(String(b.siteUrl || '')).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* brak adresu */ }
  if (!domain) return send(res, 400, { error: 'Brak adresu strony' });

  let acc = accounts.byEmail(email);
  let created = false;
  // ponowne podłączenie tej samej strony: wtyczka pamięta klucz i sekret, więc hasło nie jest potrzebne
  const prev = b.siteKey ? sites.byKey(String(b.siteKey)) : null;
  const prevOk = prev && acc && prev.account_id === acc.id && sameSecret(sites.secret(prev.id), b.secret);
  if (acc && !prevOk) {
    if (!b.password || !accounts.verify(email, String(b.password))) {
      return send(res, 409, { error: 'Konto z tym e-mailem już istnieje. Podaj hasło do panelu, aby podłączyć tę stronę.', needPassword: true });
    }
  } else if (!acc) {
    acc = accounts.create({ email, password: crypto.randomBytes(18).toString('base64url'), company: String(b.siteName || '').slice(0, 120), passwordSet: false });
    created = true;
  }

  let site = sites.byDomain(acc.id, domain);
  if (!site) {
    const limit = PLANS[acc.plan].sites;
    if (sites.count(acc.id) >= limit) return send(res, 402, { error: `Plan ${PLANS[acc.plan].name} pozwala na ${limit} ${limit === 1 ? 'stronę' : 'strony'}. Zmień plan w panelu, aby dodać kolejną.` });
    site = sites.create({ name: String(b.siteName || domain).slice(0, 120), domain, agent_phone: phone, account_id: acc.id });
  } else {
    site = sites.update(site.id, { agent_phone: phone });
  }
  send(res, 200, { siteKey: site.site_key, secret: sites.secret(site.id), accountCreated: created, panelUrl: `${publicBase(req)}/app/` });
});

// Wtyczka prosi o jednorazowy link do panelu (przycisk „Otwórz panel”).
// Klucz strony jest publiczny (widać go w kodzie strony), więc wtyczka zawsze dokłada sekret.
function pluginSite(b) {
  const site = sites.byKey(String(b.siteKey || ''));
  return site && sameSecret(sites.secret(site.id), b.secret) ? site : null;
}
function sameSecret(expected, given) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(given)).digest();
  return crypto.timingSafeEqual(a, b);
}

route('POST', '/api/wp/login-link', async (req, res) => {
  const b = await readBody(req);
  const site = pluginSite(b);
  if (!site || !site.account_id) return send(res, 401, { error: 'Nieprawidłowe dane wtyczki. Połącz stronę ponownie.' });
  send(res, 200, { url: `${publicBase(req)}/app/?login=${loginLinks.create(site.account_id)}` });
});

// Wtyczka sprawdza stan strony (czy istnieje, numer konsultanta).
route('POST', '/api/wp/status', async (req, res) => {
  const b = await readBody(req);
  const site = pluginSite(b);
  if (!site) return send(res, 401, { error: 'Nieprawidłowe dane wtyczki. Połącz stronę ponownie.' });
  send(res, 200, { name: site.name, agentPhone: site.agent_phone, open: isOpen(site.settings) });
});

function publicBase(req) {
  return tel.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
}

route('POST', '/api/auth/logout', (req, res) => {
  const t = bearer(req);
  if (t) sessions.remove(t);
  send(res, 204, '');
});

// --- panel (klient widzi tylko swoje strony, właściciel platformy wszystko) ---
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function authContext(req) {
  if (isAdmin(req)) return { superAdmin: true, accountId: null, account: null };
  const acc = sessions.account(bearer(req));
  return acc ? { superAdmin: false, accountId: acc.id, account: acc } : null;
}

// Blokada zgadywania hasła właściciela i tokenów: po 20 nieudanych próbach w 15 min z jednego IP.
const authFailures = new Map();
function recentFailures(ip) {
  const now = Date.now();
  const list = (authFailures.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  authFailures.set(ip, list);
  return list;
}
const panel = (handler) => async (req, res, params, url) => {
  const ip = clientIp(req);
  if (recentFailures(ip).length >= 20) return send(res, 429, { error: 'Zbyt wiele nieudanych prób. Spróbuj za kilka minut.' });
  const ctx = authContext(req);
  if (!ctx) {
    if (bearer(req)) recentFailures(ip).push(Date.now());
    return send(res, 401, { error: 'Brak autoryzacji' });
  }
  return handler(req, res, params, url, ctx);
};
const superOnly = (handler) => panel((req, res, params, url, ctx) =>
  ctx.superAdmin ? handler(req, res, params, url, ctx) : send(res, 403, { error: 'Brak uprawnień' }));

const ownsSite = (ctx, site) => site && (ctx.superAdmin || site.account_id === ctx.accountId);
const ownsLead = (ctx, lead) => lead && ownsSite(ctx, sites.byId(lead.site_id));

function usage(accountId) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE site_id IN (SELECT id FROM sites WHERE account_id = ?)
    AND created_at >= datetime('now', 'start of month')`).get(accountId);
  return { sites: sites.count(accountId), leadsThisMonth: n };
}

route('GET', '/api/admin/info', panel((req, res, _, __, ctx) => send(res, 200, {
  mockMode: tel.mockMode,
  contactEmail: process.env.CONTACT_EMAIL || '',
  superAdmin: ctx.superAdmin,
  account: publicAccount(ctx.account),
  plan: ctx.account ? { id: ctx.account.plan, ...PLANS[ctx.account.plan] } : null,
  usage: ctx.account ? usage(ctx.accountId) : null,
})));

route('GET', '/api/admin/sites', panel((req, res, _, __, ctx) =>
  send(res, 200, sites.list(ctx.accountId).map((s) => ({ ...s, open: isOpen(s.settings) })))));
route('POST', '/api/admin/sites', panel(async (req, res, _, __, ctx) => {
  const b = await readBody(req);
  if (!b.name) return send(res, 400, { error: 'Podaj nazwę' });
  if (!ctx.superAdmin) {
    const limit = PLANS[ctx.account.plan].sites;
    if (sites.count(ctx.accountId) >= limit) return send(res, 402, { error: `Twój plan pozwala na ${limit} ${limit === 1 ? 'stronę' : 'strony'}. Zmień plan, aby dodać kolejną.` });
  }
  if (b.agent_phone) b.agent_phone = normalizePhone(b.agent_phone);
  send(res, 201, sites.create({ name: b.name, domain: b.domain || '', agent_phone: b.agent_phone || '', account_id: ctx.accountId }));
}));
route('PUT', '/api/admin/sites/:id', panel(async (req, res, { id }, _, ctx) => {
  if (!ownsSite(ctx, sites.byId(Number(id)))) return send(res, 404, { error: 'Nie znaleziono' });
  const b = await readBody(req);
  if (b.agent_phone) {
    b.agent_phone = normalizePhone(b.agent_phone);
    if (!b.agent_phone) return send(res, 400, { error: 'Niepoprawny numer konsultanta' });
  }
  const bad = invalidSetting(b.settings);
  if (bad) return send(res, 400, { error: `Niepoprawna wartość ustawienia: ${bad}` });
  if (b.settings && b.settings.webhookUrl && !(await tel.isPublicUrl(b.settings.webhookUrl))) {
    return send(res, 400, { error: 'Webhook musi wskazywać na publiczny adres w internecie' });
  }
  send(res, 200, sites.update(Number(id), { name: b.name, domain: b.domain, agent_phone: b.agent_phone, settings: b.settings }));
}));
route('DELETE', '/api/admin/sites/:id', panel((req, res, { id }, _, ctx) => {
  if (!ownsSite(ctx, sites.byId(Number(id)))) return send(res, 404, { error: 'Nie znaleziono' });
  sites.remove(Number(id));
  send(res, 204, '');
}));

route('GET', '/api/admin/leads', panel((req, res, _, url, ctx) => {
  const q = url.searchParams;
  send(res, 200, leads.list({
    accountId: ctx.accountId,
    siteId: Number(q.get('site')) || null, status: q.get('status') || null, q: q.get('q') || null,
    limit: Math.min(Number(q.get('limit')) || 50, 500), offset: Number(q.get('offset')) || 0,
  }));
}));
route('GET', '/api/admin/leads.csv', panel((req, res, _, url, ctx) => {
  const { rows } = leads.list({ accountId: ctx.accountId, siteId: Number(url.searchParams.get('site')) || null, limit: 100000 });
  const cols = ['id', 'site_name', 'created_at', 'phone', 'name', 'status', 'scheduled_at', 'call_duration', 'tag', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'page_url', 'trigger', 'notes'];
  // apostrof przed =, +, -, @ blokuje wykonanie formuły po otwarciu w Excelu
  const esc = (v, c) => {
    let t = String(v ?? '');
    if (c !== 'phone' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const csv = '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c], c)).join(';'))].join('\n');
  send(res, 200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leady.csv"' });
}));
route('PATCH', '/api/admin/leads/:id', panel(async (req, res, { id }, _, ctx) => {
  if (!ownsLead(ctx, leads.byId(Number(id)))) return send(res, 404, { error: 'Nie znaleziono' });
  const b = await readBody(req);
  const allowed = {};
  for (const k of ['tag', 'notes', 'status']) if (b[k] !== undefined) allowed[k] = b[k];
  if (allowed.status !== undefined && !['new', 'calling', 'completed', 'scheduled', 'missed', 'agent_missed', 'failed'].includes(allowed.status)) {
    return send(res, 400, { error: 'Nieznany status' });
  }
  send(res, 200, leads.update(Number(id), allowed));
}));
route('POST', '/api/admin/leads/:id/call', panel(async (req, res, { id }, _, ctx) => {
  const lead = leads.byId(Number(id));
  if (!ownsLead(ctx, lead)) return send(res, 404, { error: 'Nie znaleziono' });
  await tel.startCall(lead, sites.byId(lead.site_id));
  send(res, 200, leads.byId(lead.id));
}));
route('GET', '/api/admin/stats', panel((req, res, _, url, ctx) => {
  send(res, 200, stats({ accountId: ctx.accountId, siteId: Number(url.searchParams.get('site')) || null, days: Math.min(Number(url.searchParams.get('days')) || 30, 365) }));
}));

route('POST', '/api/admin/password', panel(async (req, res, _, __, ctx) => {
  if (ctx.superAdmin) return send(res, 400, { error: 'Hasło właściciela zmieniasz w pliku .env' });
  const b = await readBody(req);
  if (ctx.account.password_set && !accounts.verify(ctx.account.email, String(b.current || ''))) return send(res, 400, { error: 'Obecne hasło jest nieprawidłowe' });
  if (String(b.password || '').length < 8) return send(res, 400, { error: 'Nowe hasło musi mieć co najmniej 8 znaków' });
  accounts.setPassword(ctx.accountId, b.password);
  send(res, 200, { ok: true });
}));

// --- tylko właściciel platformy ---
route('GET', '/api/admin/accounts', superOnly((req, res) => send(res, 200, accounts.list())));
route('PATCH', '/api/admin/accounts/:id', superOnly(async (req, res, { id }) => {
  const b = await readBody(req);
  if (b.plan && !PLANS[b.plan]) return send(res, 400, { error: 'Nieznany plan' });
  send(res, 200, publicAccount(accounts.update(Number(id), { plan: b.plan, company: b.company })));
}));
route('DELETE', '/api/admin/accounts/:id', superOnly((req, res, { id }) => { accounts.remove(Number(id)); send(res, 204, ''); }));

// ---------- serwer ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '', CORS);
  try {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) return await r.handler(req, res, m.groups || {}, url);
    }
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveLanding(res);
      if (url.pathname === '/downloads/callback-widget.zip') {
        return send(res, 200, buildPluginZip(publicBase(req)), {
          'content-type': 'application/zip', 'content-disposition': 'attachment; filename="callback-widget.zip"', 'cache-control': 'no-store',
        });
      }
      if (url.pathname === '/admin' || url.pathname === '/app') { res.writeHead(302, { location: url.pathname + '/' }); return res.end(); }
      // panel klienta i panel właściciela to ta sama aplikacja, tryb rozpoznaje po adresie
      if (url.pathname === '/app/' || url.pathname === '/admin/') return serveStatic(res, '/panel/index.html');
      if (url.pathname === '/demo') return serveStatic(res, '/demo.html') || send(res, 404, 'Not found');
      const rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
      if (serveStatic(res, rel)) return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.status === 413) return res.headersSent || send(res, 413, { error: 'Zbyt duże żądanie' }, { connection: 'close' });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Błąd serwera' });
  }
});

// Landing page z działającym widgetem (leady trafiają do strony właściciela platformy).
function serveLanding(res) {
  const key = process.env.LANDING_SITE_KEY || sites.list().find((s) => !s.account_id)?.site_key || '';
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.html'), 'utf8').replaceAll('{{SITE_KEY}}', key);
  send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
}

// Harmonogram: zaplanowane oddzwonienia i ponowienia.
setInterval(() => {
  for (const lead of leads.due()) {
    const site = sites.byId(lead.site_id);
    if (!site) continue;
    if (isOpen(site.settings)) tel.startCall(lead, site);
    else {
      const next = availableSlots(site.settings, { days: 7 })[0];
      if (next) leads.update(lead.id, { scheduled_at: next.at });
    }
  }
}, 15000).unref();

if (!sites.list().some((s) => !s.account_id)) {
  const s = sites.create({ name: 'Strona produktu (landing)', domain: '', agent_phone: tel.mockMode ? '+48500000000' : '' });
  console.log(`Utworzono stronę właściciela dla landing page. Klucz widgetu: ${s.site_key}`);
}

server.listen(PORT, () => {
  console.log(`Callback działa: http://localhost:${PORT}  (landing: /, panel klienta: /app/, panel właściciela: /admin/)`);
  if (tel.mockMode) console.log('TRYB DEMO: brak konfiguracji Twilio, zgłoszenia czekają jako „Nowe”, system nie dzwoni.');
  if (!process.env.ADMIN_PASSWORD) console.warn(`UWAGA: brak ADMIN_PASSWORD. Jednorazowe hasło właściciela do tego uruchomienia: ${ADMIN_PASSWORD}`);
});
