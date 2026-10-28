'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'callback.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    agent_phone TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    phone TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    scheduled_at TEXT,
    page_url TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    trigger TEXT,
    ip TEXT,
    call_sid TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    call_started_at TEXT,
    call_duration INTEGER,
    recording_url TEXT,
    tag TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS leads_site_created ON leads(site_id, created_at);
  CREATE INDEX IF NOT EXISTS leads_status ON leads(status, scheduled_at);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS events_site ON events(site_id, type, created_at);
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    company TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    expires_at TEXT NOT NULL
  );
`);
// migracje
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
// strony należą do kont (NULL = strona właściciela platformy)
if (!hasCol('sites', 'account_id')) db.exec('ALTER TABLE sites ADD COLUMN account_id INTEGER REFERENCES accounts(id)');
// sekret wtyczki WordPress (logowanie do panelu z kokpitu WP)
if (!hasCol('sites', 'api_secret')) db.exec('ALTER TABLE sites ADD COLUMN api_secret TEXT');
// konta założone z wtyczki nie mają jeszcze własnego hasła
if (!hasCol('accounts', 'password_set')) db.exec('ALTER TABLE accounts ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS login_links (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL
)`);

const DEFAULT_SETTINGS = {
  color: '#7C3AED',
  theme: 'dark',          // dark | light
  position: 'right',
  title: 'Zadzwonimy do Ciebie w 30 sekund!',
  subtitle: 'Zostaw numer, a nasz konsultant oddzwoni za darmo.',
  buttonText: 'Zadzwońcie do mnie',
  offHoursTitle: 'Jesteśmy teraz poza godzinami pracy',
  offHoursSubtitle: 'Wybierz dogodny termin, a oddzwonimy.',
  thankYou: 'Dziękujemy! Właśnie łączymy rozmowę…',
  thankYouScheduled: 'Dziękujemy! Zadzwonimy w wybranym terminie.',
  // false = bez ekranu „łączymy rozmowę” i bez przełącznika „Zadzwońcie teraz”
  liveCall: false,
  thankYouQueued: 'Dziękujemy! Oddzwonimy w ciągu 30 sekund.',
  timezone: 'Europe/Warsaw',
  // dzień tygodnia 0 = niedziela; null = nieczynne
  hours: { 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'], 5: ['09:00', '17:00'], 6: null, 0: null },
  autoOpenSeconds: 0,      // 0 = wyłączone
  exitIntent: true,
  exitIntentTitle: 'Zanim wyjdziesz… oddzwonimy w 30 sekund!',
  // dymek z konsultantem przy słuchawce
  teaser: true,
  teaserDelay: 3,          // sekundy od wejścia na stronę
  teaserGreeting: 'Cześć',
  teaserText: 'Masz pytanie? Oddzwonimy do Ciebie w 30 sekund!',
  avatarUrl: '',           // puste = domyślna grafika konsultanta
  maxAttempts: 2,
  recordCalls: false,
  agentGreeting: 'Klient ze strony prosi o kontakt. Łączę.',
  notifyEmail: '',
};

function newSiteKey() {
  return crypto.randomBytes(9).toString('base64url');
}

function rowToSite(row) {
  if (!row) return null;
  const { api_secret, ...rest } = row;
  return { ...rest, settings: { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings || '{}') } };
}

const sites = {
  list: (accountId) => (accountId
    ? db.prepare('SELECT * FROM sites WHERE account_id = ? ORDER BY id').all(accountId)
    : db.prepare('SELECT * FROM sites ORDER BY id').all()).map(rowToSite),
  count: (accountId) => db.prepare('SELECT COUNT(*) AS n FROM sites WHERE account_id = ?').get(accountId).n,
  byId: (id) => rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id)),
  byKey: (key) => rowToSite(db.prepare('SELECT * FROM sites WHERE site_key = ?').get(key)),
  create({ name, domain = '', agent_phone = '', settings = {}, account_id = null }) {
    const key = newSiteKey();
    const r = db.prepare('INSERT INTO sites (site_key, name, domain, agent_phone, settings, account_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, name, domain, agent_phone, JSON.stringify(settings), account_id);
    return sites.byId(r.lastInsertRowid);
  },
  update(id, { name, domain, agent_phone, settings }) {
    const cur = sites.byId(id);
    if (!cur) return null;
    // zapisujemy tylko nadpisania, żeby zmiany domyślnych ustawień obejmowały istniejące strony
    const stored = JSON.parse(db.prepare('SELECT settings FROM sites WHERE id = ?').get(id).settings || '{}');
    db.prepare('UPDATE sites SET name = ?, domain = ?, agent_phone = ?, settings = ? WHERE id = ?').run(
      name ?? cur.name, domain ?? cur.domain, agent_phone ?? cur.agent_phone,
      JSON.stringify({ ...stored, ...(settings || {}) }), id);
    return sites.byId(id);
  },
  remove(id) {
    db.prepare('DELETE FROM leads WHERE site_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE site_id = ?').run(id);
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  },
};

const LEAD_FIELDS = ['phone', 'name', 'status', 'scheduled_at', 'page_url', 'referrer', 'utm_source', 'utm_medium',
  'utm_campaign', 'trigger', 'ip', 'call_sid', 'attempts', 'call_started_at', 'call_duration', 'recording_url', 'tag', 'notes'];

const leads = {
  create(siteId, data) {
    const cols = LEAD_FIELDS.filter((f) => data[f] !== undefined);
    const r = db.prepare(`INSERT INTO leads (site_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(siteId, ...cols.map((c) => data[c]));
    return leads.byId(r.lastInsertRowid);
  },
  byId: (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id),
  remove: (id) => db.prepare('DELETE FROM leads WHERE id = ?').run(id),
  bySid: (sid) => db.prepare('SELECT * FROM leads WHERE call_sid = ?').get(sid),
  update(id, data) {
    const cols = LEAD_FIELDS.filter((f) => data[f] !== undefined);
    if (!cols.length) return leads.byId(id);
    db.prepare(`UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...cols.map((c) => data[c]), id);
    return leads.byId(id);
  },
  list({ accountId, siteId, status, q, limit = 100, offset = 0 }) {
    const where = [];
    const args = [];
    if (accountId) { where.push('l.site_id IN (SELECT id FROM sites WHERE account_id = ?)'); args.push(accountId); }
    if (siteId) { where.push('l.site_id = ?'); args.push(siteId); }
    if (status) { where.push('l.status = ?'); args.push(status); }
    if (q) { where.push('(l.phone LIKE ? OR l.name LIKE ? OR l.notes LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT l.*, s.name AS site_name FROM leads l JOIN sites s ON s.id = l.site_id ${w}
      ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM leads l ${w}`).get(...args);
    return { rows, total: n };
  },
  due() {
    return db.prepare(`SELECT * FROM leads WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20`)
      .all(new Date().toISOString());
  },
  recentFromIp(ip, minutes) {
    return db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ip = ? AND created_at >= datetime('now', ?)`)
      .get(ip, `-${minutes} minutes`).n;
  },
};

function stats({ accountId, siteId, days = 30 }) {
  let siteFilter = '';
  const a = [];
  if (siteId) { siteFilter += ' AND site_id = ?'; a.push(siteId); }
  if (accountId) { siteFilter += ' AND site_id IN (SELECT id FROM sites WHERE account_id = ?)'; a.push(accountId); }
  const since = `-${days} days`;
  const totals = db.prepare(`SELECT status, COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', ?) ${siteFilter} GROUP BY status`).all(since, ...a);
  const perDay = db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS n,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM leads WHERE created_at >= datetime('now', ?) ${siteFilter} GROUP BY day ORDER BY day`).all(since, ...a);
  const bySource = db.prepare(`SELECT COALESCE(NULLIF(utm_source, ''), CASE WHEN referrer IS NULL OR referrer = '' THEN '(bezpośrednio)' ELSE referrer END) AS source,
      COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', ?) ${siteFilter} GROUP BY source ORDER BY n DESC LIMIT 10`).all(since, ...a);
  const byTrigger = db.prepare(`SELECT COALESCE(trigger, 'button') AS trigger, COUNT(*) AS n FROM leads
    WHERE created_at >= datetime('now', ?) ${siteFilter} GROUP BY 1 ORDER BY n DESC`).all(since, ...a);
  const speed = db.prepare(`SELECT AVG((julianday(call_started_at) - julianday(created_at)) * 86400) AS avg_s
    FROM leads WHERE call_started_at IS NOT NULL AND scheduled_at IS NULL AND created_at >= datetime('now', ?) ${siteFilter}`).get(since, ...a);
  const talk = db.prepare(`SELECT AVG(call_duration) AS avg_d, SUM(call_duration) AS sum_d FROM leads
    WHERE call_duration > 0 AND created_at >= datetime('now', ?) ${siteFilter}`).get(since, ...a);
  const ev = db.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE created_at >= datetime('now', ?) ${siteFilter} GROUP BY type`).all(since, ...a);
  return {
    days,
    totals: Object.fromEntries(totals.map((r) => [r.status, r.n])),
    leads: totals.reduce((s, r) => s + r.n, 0),
    perDay,
    bySource,
    byTrigger,
    avgSecondsToCall: speed.avg_s ? Math.round(speed.avg_s) : null,
    avgCallDuration: talk.avg_d ? Math.round(talk.avg_d) : null,
    totalTalkSeconds: talk.sum_d || 0,
    events: Object.fromEntries(ev.map((r) => [r.type, r.n])),
  };
}

function trackEvent(siteId, type) {
  db.prepare('INSERT INTO events (site_id, type) VALUES (?, ?)').run(siteId, type);
}

// ---------- konta klientów ----------

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicAccount = (a) => a && { id: a.id, email: a.email, company: a.company, plan: a.plan, created_at: a.created_at, password_set: !!a.password_set };

const accounts = {
  create({ email, password, company, passwordSet = true }) {
    const r = db.prepare('INSERT INTO accounts (email, password_hash, company, password_set) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), company || null, passwordSet ? 1 : 0);
    return accounts.byId(r.lastInsertRowid);
  },
  byId: (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id),
  byEmail: (email) => db.prepare('SELECT * FROM accounts WHERE email = ?').get(email),
  verify(email, password) {
    const a = accounts.byEmail(email);
    return a && checkPassword(password, a.password_hash) ? a : null;
  },
  update(id, { company, plan }) {
    const a = accounts.byId(id);
    db.prepare('UPDATE accounts SET company = ?, plan = ? WHERE id = ?').run(company ?? a.company, plan ?? a.plan, id);
    return accounts.byId(id);
  },
  setPassword: (id, pw) => db.prepare('UPDATE accounts SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(pw), id),
  list: () => db.prepare(`SELECT a.id, a.email, a.company, a.plan, a.created_at, a.last_login_at,
      (SELECT COUNT(*) FROM sites s WHERE s.account_id = a.id) AS sites,
      (SELECT COUNT(*) FROM leads l JOIN sites s ON s.id = l.site_id WHERE s.account_id = a.id) AS leads,
      (SELECT COUNT(*) FROM leads l JOIN sites s ON s.id = l.site_id WHERE s.account_id = a.id AND l.created_at >= datetime('now', '-30 days')) AS leads_30d
    FROM accounts a ORDER BY a.id DESC`).all(),
  remove(id) {
    for (const s of sites.list(id)) sites.remove(s.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
};

const sessions = {
  create(accountId, days = 30) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', ?))").run(sha(token), accountId, `+${days} days`);
    db.prepare("UPDATE accounts SET last_login_at = datetime('now') WHERE id = ?").run(accountId);
    return token;
  },
  account(token) {
    if (!token) return null;
    const row = db.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(sha(token));
    return row ? accounts.byId(row.account_id) : null;
  },
  remove: (token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)),
};

// Jednorazowe linki logowania (przycisk „Otwórz panel” we wtyczce WordPress).
const loginLinks = {
  create(accountId) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare("INSERT INTO login_links (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))").run(sha(token), accountId);
    return token;
  },
  consume(token) {
    const row = db.prepare("SELECT account_id FROM login_links WHERE token_hash = ? AND expires_at > datetime('now')").get(sha(String(token || '')));
    db.prepare("DELETE FROM login_links WHERE token_hash = ? OR expires_at <= datetime('now')").run(sha(String(token || '')));
    return row ? row.account_id : null;
  },
};

sites.secret = (id) => {
  const s = db.prepare('SELECT api_secret FROM sites WHERE id = ?').get(id);
  if (s && s.api_secret) return s.api_secret;
  const secret = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE sites SET api_secret = ? WHERE id = ?').run(secret, id);
  return secret;
};
sites.byDomain = (accountId, domain) => rowToSite(db.prepare('SELECT * FROM sites WHERE account_id = ? AND domain = ?').get(accountId, domain));

module.exports = { db, sites, leads, stats, trackEvent, accounts, sessions, loginLinks, publicAccount, DEFAULT_SETTINGS };
