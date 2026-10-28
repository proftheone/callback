'use strict';
// Testy bezpieczeństwa: uruchamiają serwer na czystej bazie i próbują typowych ataków.
// Użycie: node test/security.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PORT = 39000 + Math.floor(Math.random() * 500);
const B = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-haslo-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbsec-'));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };

function req(method, p, { body, headers = {}, raw } = {}) {
  return new Promise((resolve) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(B + p, { method, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data !== undefined) r.write(data);
    r.end();
  });
}
const adm = { authorization: `Bearer ${ADMIN}` };

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: ADMIN, DB_PATH: path.join(dir, 't.db'), PUBLIC_URL: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_NUMBER: '', SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !(await req('GET', '/health')).status; i++) await new Promise((r) => setTimeout(r, 100));

  // dwa konta klientów
  const a = (await req('POST', '/api/auth/register', { body: { email: 'a@test.pl', password: 'haslo-aaaa-1', website: 'a-firma.pl' } })).json;
  const b = (await req('POST', '/api/auth/register', { body: { email: 'b@test.pl', password: 'haslo-bbbb-1', website: 'b-firma.pl' } })).json;
  const A = { authorization: `Bearer ${a.token}` }, Bh = { authorization: `Bearer ${b.token}` };
  const siteA = (await req('GET', '/api/admin/sites', { headers: A })).json[0];
  const siteB = (await req('GET', '/api/admin/sites', { headers: Bh })).json[0];
  await req('PUT', `/api/admin/sites/${siteB.id}`, { headers: Bh, body: { agent_phone: '600111222' } });
  const leadB = (await req('POST', `/api/widget/${siteB.site_key}/callback`, { body: { phone: '600200300' }, headers: { origin: 'https://b-firma.pl', 'x-forwarded-for': '10.0.0.9' } })).json;
  const leadsB = (await req('GET', '/api/admin/leads', { headers: Bh })).json.rows;
  const lidB = leadsB[0] && leadsB[0].id;

  // 1. Dostęp do cudzych danych (IDOR)
  const la = (await req('GET', '/api/admin/leads', { headers: A })).json;
  check('Klient A nie widzi leadów klienta B', la.rows.every((l) => l.site_id !== siteB.id));
  check('Klient A nie zmieni leada klienta B', (await req('PATCH', `/api/admin/leads/${lidB}`, { headers: A, body: { notes: 'x' } })).status === 404);
  check('Klient A nie usunie leada klienta B', (await req('DELETE', `/api/admin/leads/${lidB}`, { headers: A })).status === 404);
  check('Klient A nie zmieni strony klienta B', (await req('PUT', `/api/admin/sites/${siteB.id}`, { headers: A, body: { name: 'x' } })).status === 404);
  check('Klient A nie usunie strony klienta B', (await req('DELETE', `/api/admin/sites/${siteB.id}`, { headers: A })).status === 404);
  check('Klient nie ma dostępu do listy kont', (await req('GET', '/api/admin/accounts', { headers: A })).status === 403);
  check('Klient nie zmieni sobie planu', (await req('PATCH', `/api/admin/accounts/${a.account.id}`, { headers: A, body: { plan: 'business' } })).status === 403);
  check('Panel bez logowania zwraca 401', (await req('GET', '/api/admin/leads')).status === 401);
  check('Sfałszowany token nie działa', (await req('GET', '/api/admin/leads', { headers: { authorization: 'Bearer ' + 'a'.repeat(43) } })).status === 401);

  // 2. Wstrzyknięcia
  const sq = await req('GET', `/api/admin/leads?q=${encodeURIComponent("' OR 1=1 --")}`, { headers: A });
  check('SQL injection w wyszukiwarce nie zwraca cudzych danych', sq.status === 200 && sq.json.rows.length === 0);
  const tr = await req('GET', '/../../etc/passwd');
  const tr2 = await req('GET', '/%2e%2e/%2e%2e/src/server.js');
  check('Path traversal nie czyta plików spoza public/', !/root:|require\(/.test(tr.text + tr2.text));
  const big = await req('POST', `/api/widget/${siteA.site_key}/callback`, { raw: '{"phone":"' + 'x'.repeat(200000) + '"}' });
  check('Zbyt duże żądanie jest odrzucane, serwer działa dalej', big.status === 413 && (await req('GET', '/health')).status === 200, `status ${big.status}`);

  // 3. XSS przez dane z widgetu
  await req('POST', `/api/widget/${siteA.site_key}/callback`, { body: { phone: '600300400', pageUrl: 'javascript:alert(document.cookie)', referrer: 'javascript:alert(1)', name: '<img src=x onerror=alert(1)>' }, headers: { 'x-forwarded-for': '10.0.0.1' } });
  const lx = (await req('GET', '/api/admin/leads', { headers: A })).json.rows.find((l) => l.phone === '+48600300400');
  check('Adres strony typu javascript: nie jest zapisywany', lx && !/^javascript:/i.test(lx.page_url || '') && !/^javascript:/i.test(lx.referrer || ''), lx && lx.page_url);
  const panelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel', 'index.html'), 'utf8');
  check('Panel wyświetla linki tylko http(s)', /safeUrl/.test(panelHtml));
  const col = await req('PUT', `/api/admin/sites/${siteA.id}`, { headers: A, body: { settings: { color: 'red;}</style><img src=x onerror=alert(1)>' } } });
  const cfg = (await req('GET', `/api/widget/${siteA.site_key}/config`)).json;
  check('Kolor widgetu nie przyjmuje kodu HTML/CSS', !/[<>;{}]/.test(cfg.color || ''), `status ${col.status}`);

  // 4. Limity i podszywanie się
  let last;
  for (let i = 0; i < 6; i++) last = await req('POST', `/api/widget/${siteA.site_key}/callback`, { body: { phone: `60040050${i}` }, headers: { 'x-forwarded-for': `1.2.3.${i}` } });
  check('Limit zgłoszeń nie da się obejść podmianą X-Forwarded-For', last.status === 429, `ostatni status ${last.status}`);
  const other = await req('POST', `/api/widget/${siteB.site_key}/callback`, { body: { phone: '600999888' }, headers: { origin: 'https://evil.example' } });
  check('Widget odrzuca zgłoszenia z obcej domeny', other.status === 403);
  let brute;
  for (let i = 0; i < 40; i++) brute = await req('GET', '/api/admin/leads', { headers: { authorization: `Bearer zgadywane-${i}`, 'cf-connecting-ip': '6.6.6.6' } });
  check('Zgadywanie hasła właściciela jest blokowane', brute.status === 429, `po 40 próbach: ${brute.status}`);
  check('Poprawne hasło właściciela nadal działa z innego IP', (await req('GET', '/api/admin/accounts', { headers: { ...adm, 'cf-connecting-ip': '5.5.5.5' } })).status === 200);

  // 5. Webhooki Twilio i wtyczka
  const tw = await req('POST', `/twilio/recording?lead=${lidB}`, { raw: 'RecordingUrl=javascript:alert(1)//', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const lb = (await req('GET', '/api/admin/leads', { headers: Bh })).json.rows.find((l) => l.id === lidB);
  check('Fałszywy webhook Twilio nie zmienia leada', tw.status === 403 && !lb.recording_url, `status ${tw.status}`);
  const st = await req('POST', '/api/wp/status', { body: { siteKey: siteB.site_key } });
  check('Publiczny klucz strony nie ujawnia numeru konsultanta', !(st.text || '').includes('600111222'), `status ${st.status}`);

  // 6. SSRF przez webhook klienta
  const hook = await req('PUT', `/api/admin/sites/${siteA.id}`, { headers: A, body: { settings: { webhookUrl: 'http://169.254.169.254/latest/meta-data/' } } });
  const hook2 = await req('PUT', `/api/admin/sites/${siteA.id}`, { headers: A, body: { settings: { webhookUrl: `http://127.0.0.1:${PORT}/health` } } });
  check('Webhook nie może wskazywać na adresy wewnętrzne', hook.status === 400 && hook2.status === 400, `${hook.status}/${hook2.status}`);

  // 7. Eksport CSV
  await req('POST', `/api/widget/${siteB.site_key}/callback`, { body: { phone: '600777666', utm_campaign: '=HYPERLINK("http://evil","x")' }, headers: { origin: 'https://b-firma.pl', 'cf-connecting-ip': '7.7.7.7' } });
  const csv = await req('GET', '/api/admin/leads.csv', { headers: Bh });
  check('CSV neutralizuje formuły Excela', !/;"=HYPERLINK/.test(csv.text));

  // 8. Nagłówki i hasła
  const h = (await req('GET', '/app/')).headers;
  check('Nagłówki bezpieczeństwa w panelu', h['x-content-type-options'] === 'nosniff' && /deny/i.test(h['x-frame-options'] || '') && !!h['referrer-policy']);
  check('Hasło krótsze niż 8 znaków odrzucone', (await req('POST', '/api/auth/register', { body: { email: 'c@test.pl', password: '123' }, headers: { 'cf-connecting-ip': '8.8.1.1' } })).status === 400);
  const db = fs.readFileSync(path.join(dir, 't.db')).toString('latin1');
  check('Hasła w bazie są hashowane', !db.includes('haslo-aaaa-1'));
  const sess = await req('POST', '/api/auth/login', { body: { email: 'a@test.pl', password: 'zle-haslo-x' }, headers: { 'cf-connecting-ip': '8.8.2.2' } });
  check('Złe hasło klienta odrzucone', sess.status === 401);

  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} testów zaliczonych`);
  process.exit(failed ? 1 : 0);
})();
