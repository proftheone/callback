'use strict';
// Godziny pracy liczone w strefie czasowej strony (domyślnie Europe/Warsaw).

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: WEEKDAYS[get('weekday')], minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function isOpen(settings, date = new Date()) {
  const { day, minutes } = localParts(date, settings.timezone);
  const range = settings.hours && settings.hours[day];
  if (!range) return false;
  return minutes >= toMin(range[0]) && minutes < toMin(range[1]);
}

// Lista terminów (co 30 min) w godzinach pracy na najbliższe `days` dni.
function availableSlots(settings, { days = 7, stepMin = 30, from = new Date() } = {}) {
  const step = stepMin * 60 * 1000;
  let t = Math.ceil((from.getTime() + 15 * 60 * 1000) / step) * step;
  const end = from.getTime() + days * 86400 * 1000;
  const fmtDay = new Intl.DateTimeFormat('pl-PL', { timeZone: settings.timezone, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('pl-PL', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' });
  const out = [];
  for (; t < end; t += step) {
    const d = new Date(t);
    if (isOpen(settings, d)) out.push({ at: d.toISOString(), day: fmtDay.format(d), time: fmtTime.format(d) });
  }
  return out;
}

module.exports = { isOpen, availableSlots };
