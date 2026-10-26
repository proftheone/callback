'use strict';
// Logika połączeń: najpierw dzwonimy do konsultanta, po odebraniu łączymy go z klientem.
// Bez danych Twilio aplikacja nie dzwoni: zgłoszenia zostają ze statusem „new”.
const crypto = require('node:crypto');
const { leads } = require('./db');

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_NUMBER;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const RETRY_DELAY_MIN = Number(process.env.RETRY_DELAY_MIN || 2);

const mockMode = !(SID && TOKEN && FROM && PUBLIC_URL);

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function notifyWebhook(site, lead, event) {
  const url = site.settings.webhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, site: { id: site.id, name: site.name }, lead }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[webhook]', e.message);
  }
}

async function startCall(lead, site) {
  // Bez Twilio nie dzwonimy i nie wymyślamy wyniku: zgłoszenie czeka jako „Nowe”
  // (zaplanowane przechodzi w „Nowe”, gdy nadejdzie jego termin).
  if (mockMode) {
    if (lead.status !== 'new') leads.update(lead.id, { status: 'new' });
    return;
  }
  const attempts = lead.attempts + 1;
  if (!site.agent_phone) {
    leads.update(lead.id, { status: 'failed', notes: appendNote(lead, 'Brak numeru konsultanta w ustawieniach strony.') });
    return;
  }
  leads.update(lead.id, { status: 'calling', attempts, call_started_at: new Date().toISOString() });

  const params = new URLSearchParams({
    To: site.agent_phone,
    From: FROM,
    Url: `${PUBLIC_URL}/twilio/agent-answer?lead=${lead.id}`,
    StatusCallback: `${PUBLIC_URL}/twilio/status?lead=${lead.id}`,
    Timeout: '20',
  });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64') },
      body: params,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    leads.update(lead.id, { call_sid: body.sid });
  } catch (e) {
    console.error('[twilio] startCall', e.message);
    leads.update(lead.id, { status: 'failed', notes: appendNote(lead, `Błąd Twilio: ${e.message}`) });
  }
}

function appendNote(lead, text) {
  return [lead.notes, `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${text}`].filter(Boolean).join('\n');
}

// TwiML po odebraniu przez konsultanta: komunikat + połączenie z klientem.
function agentAnswerTwiml(lead, site) {
  const rec = site.settings.recordCalls
    ? ` record="record-from-answer-dual" recordingStatusCallback="${xml(`${PUBLIC_URL}/twilio/recording?lead=${lead.id}`)}"`
    : '';
  const greeting = `${site.settings.agentGreeting} ${site.name}.`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say language="pl-PL">${xml(greeting)}</Say>` +
    `<Dial callerId="${xml(FROM)}" timeout="25" action="${xml(`${PUBLIC_URL}/twilio/dial-done?lead=${lead.id}`)}"${rec}>` +
    `<Number>${xml(lead.phone)}</Number></Dial></Response>`;
}

// Wynik połączenia z klientem.
function dialDone(lead, site, p) {
  const st = p.DialCallStatus;
  const duration = Number(p.DialCallDuration || 0);
  let updated;
  if (st === 'completed') updated = leads.update(lead.id, { status: 'completed', call_duration: duration });
  else updated = leads.update(lead.id, { status: 'missed', notes: appendNote(lead, `Klient nie odebrał (${st}).`) });
  notifyWebhook(site, updated, 'call.finished');
  const say = st === 'completed' ? '' : '<Say language="pl-PL">Klient nie odebrał.</Say>';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}</Response>`;
}

// Status rozmowy z konsultantem; gdy nie odebrał, ponawiamy.
function callStatus(lead, site, p) {
  const st = p.CallStatus;
  if (!['no-answer', 'busy', 'failed', 'canceled'].includes(st)) return;
  if (lead.status !== 'calling') return; // dial-done już ustawił wynik
  scheduleRetry(lead, site, `Konsultant nie odebrał (${st}).`);
}

function scheduleRetry(lead, site, reason) {
  const fresh = leads.byId(lead.id);
  if (fresh.attempts < site.settings.maxAttempts) {
    const at = new Date(Date.now() + RETRY_DELAY_MIN * 60 * 1000).toISOString();
    leads.update(lead.id, { status: 'scheduled', scheduled_at: at, notes: appendNote(fresh, `${reason} Ponowienie o ${at.slice(11, 16)} UTC.`) });
  } else {
    const updated = leads.update(lead.id, { status: 'agent_missed', notes: appendNote(fresh, reason) });
    notifyWebhook(site, updated, 'call.missed');
  }
}

function recording(lead, p) {
  if (p.RecordingUrl) leads.update(lead.id, { recording_url: `${p.RecordingUrl}.mp3` });
}

// Weryfikacja podpisu X-Twilio-Signature.
function validSignature(url, params, signature) {
  if (mockMode) return true;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


module.exports = { mockMode, startCall, agentAnswerTwiml, dialDone, callStatus, recording, validSignature, notifyWebhook, PUBLIC_URL };
