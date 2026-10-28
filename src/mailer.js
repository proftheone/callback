'use strict';
// Minimalny klient SMTP (bez zależności): port 465 = TLS od razu, inne porty = STARTTLS.
// Konfiguracja: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

const cfg = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
});

const enabled = () => !!(cfg().host && cfg().from);

// Czyta odpowiedzi serwera SMTP (wieloliniowe „250-…” kończą się linią „250 …”).
function reader(socket) {
  let buf = '';
  let waiting = null;
  const queue = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let m;
    while ((m = buf.match(/^(\d{3}) .*\r?\n/m))) {
      const end = buf.indexOf(m[0]) + m[0].length;
      const reply = { code: Number(m[1]), text: buf.slice(0, end) };
      buf = buf.slice(end);
      if (waiting) { const w = waiting; waiting = null; w(reply); } else queue.push(reply);
    }
  };
  socket.on('data', onData);
  return {
    next: () => new Promise((resolve) => (queue.length ? resolve(queue.shift()) : (waiting = resolve))),
    detach: () => socket.off('data', onData),
  };
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host, timeout: 15000 };
    const s = c.port === 465 ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.once('error', reject);
    s.once('timeout', () => { s.destroy(); reject(new Error('SMTP: przekroczony czas połączenia')); });
  });
}

const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const cleanAddr = (s) => String(s).replace(/[\r\n<>]/g, '').trim();

function buildMessage({ from, to, subject, text, html }) {
  const boundary = 'b' + crypto.randomBytes(12).toString('hex');
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const fromAddr = cleanAddr(from);
  return [
    `From: ${encHeader('Callback')} <${fromAddr}>`,
    `To: ${to.map(cleanAddr).join(', ')}`,
    `Subject: ${encHeader(subject.replace(/[\r\n]/g, ' '))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${fromAddr.split('@')[1] || 'callback'}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html || text),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function sendMail({ to, subject, text, html }) {
  const c = cfg();
  if (!enabled()) throw new Error('SMTP nie jest skonfigurowany');
  const rcpts = [...new Set(to.map(cleanAddr).filter(Boolean))];
  if (!rcpts.length) return;

  let socket = await connect(c);
  let r = reader(socket);
  const cmd = async (line, expect) => {
    if (line !== null) socket.write(line + '\r\n');
    const res = await r.next();
    if (!expect.includes(res.code)) throw new Error(`SMTP ${res.code}: ${res.text.trim().split('\n').pop()}`);
    return res;
  };
  try {
    await cmd(null, [220]);
    const helo = `EHLO ${os.hostname() || 'callback'}`;
    let ehlo = await cmd(helo, [250]);
    if (c.port !== 465) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP: serwer nie obsługuje STARTTLS');
      await cmd('STARTTLS', [220]);
      r.detach();
      socket = tls.connect({ socket, servername: c.host });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      r = reader(socket);
      ehlo = await cmd(helo, [250]);
    }
    if (c.user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(Buffer.from(c.user).toString('base64'), [334]);
      await cmd(Buffer.from(c.pass).toString('base64'), [235]);
    }
    await cmd(`MAIL FROM:<${cleanAddr(c.from)}>`, [250]);
    for (const rc of rcpts) await cmd(`RCPT TO:<${rc}>`, [250, 251]);
    await cmd('DATA', [354]);
    // linie zaczynające się od kropki trzeba podwoić (dot-stuffing)
    const body = buildMessage({ from: c.from, to: rcpts, subject, text, html }).replace(/^\./gm, '..');
    await cmd(body + '\r\n.', [250]);
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}

module.exports = { sendMail, enabled, buildMessage };
