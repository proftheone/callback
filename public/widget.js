/* Widget oddzwaniania. Osadzenie:
   <script src="https://TWOJ-SERWER/widget.js" data-site="KLUCZ_STRONY" async></script> */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-site]');
  if (!script || window.__cbWidget) return;
  window.__cbWidget = true;
  var KEY = script.getAttribute('data-site');
  var BASE = new URL(script.src).origin;
  var API = BASE + '/api/widget/' + encodeURIComponent(KEY);

  function store(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; }
  }

  // Źródło wejścia zapamiętane z pierwszej strony w sesji.
  var qs = new URLSearchParams(location.search);
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (qs.get(k)) store('cb_' + k, qs.get(k)); });
  if (store('cb_ref') === null) store('cb_ref', document.referrer && new URL(document.referrer).hostname !== location.hostname ? document.referrer : '');

  function post(path, body) {
    return fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  fetch(API + '/config').then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (cfg) render(cfg);
  }).catch(function () {});

  function render(cfg) {
    post('/event', { type: 'view' });
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + (cfg.position === 'left' ? 'left:0' : 'right:0');
    var root = host.attachShadow({ mode: 'open' });
    var c = cfg.color || '#2563eb';
    var side = cfg.position === 'left' ? 'left' : 'right';

    var dark = cfg.theme !== 'light';
    var t = dark
      ? { bg: '#0e0e12', bg2: '#15151b', text: '#f4f4f6', muted: '#9a9aa8', line: '#26262f', input: '#0a0a0d' }
      : { bg: '#ffffff', bg2: '#f7f7f9', text: '#111118', muted: '#5b5b68', line: '#e4e4ea', input: '#ffffff' };
    root.innerHTML =
      '<style>' +
      ':host{all:initial;font-family:Geist,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--c:' + c + '}' +
      '*{box-sizing:border-box;font-family:inherit}' +
      '.btn{position:fixed;bottom:24px;' + side + ':24px;width:66px;height:66px;border-radius:50%;border:0;background:radial-gradient(circle at 30% 25%,rgba(255,255,255,.35),transparent 55%),var(--c);color:#fff;cursor:pointer;box-shadow:0 10px 30px -6px var(--c),0 0 0 1px rgba(255,255,255,.12) inset;display:flex;align-items:center;justify-content:center;transition:transform .2s}' +
      '.btn:hover{transform:scale(1.08)}' +
      '.btn::before,.btn::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--c);animation:pulse 2.4s infinite;z-index:-1}' +
      '.btn::after{animation-delay:1.2s}' +
      '.btn svg{animation:ring 3s infinite}' +
      '.dot{position:absolute;top:4px;right:4px;width:14px;height:14px;border-radius:50%;background:#22c55e;border:2px solid #fff}' +
      '@keyframes pulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.8);opacity:0}}' +
      '@keyframes ring{0%,80%,100%{transform:rotate(0)}84%{transform:rotate(-15deg)}88%{transform:rotate(15deg)}92%{transform:rotate(-10deg)}96%{transform:rotate(10deg)}}' +
      '.panel{position:fixed;bottom:106px;' + side + ':24px;width:360px;max-width:calc(100vw - 32px);background:' + t.bg + ';color:' + t.text + ';border:1px solid ' + t.line + ';border-radius:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.55),0 0 60px -30px var(--c);padding:26px;display:none;animation:in .25s cubic-bezier(.2,.9,.3,1.2);overflow:hidden}' +
      '.panel::before{content:"";position:absolute;inset:-1px -1px auto;height:120px;background:radial-gradient(260px 120px at 50% -40px,var(--c),transparent 70%);opacity:' + (dark ? '.35' : '.18') + ';pointer-events:none}' +
      '.panel>*{position:relative}' +
      '.panel.open{display:block}' +
      '@keyframes in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}' +
      '.x{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;background:' + t.bg2 + ';border:1px solid ' + t.line + ';font-size:18px;color:' + t.muted + ';cursor:pointer;line-height:1;z-index:2}' +
      '.pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:' + t.muted + ';background:' + t.bg2 + ';border:1px solid ' + t.line + ';padding:5px 11px;border-radius:999px;margin-bottom:14px}' +
      '.pill b{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2)}' +
      '.pill.off b{background:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.2)}' +
      'h3{margin:0 0 8px;font-size:21px;line-height:1.25;font-weight:800;letter-spacing:-.02em;padding-right:24px}' +
      'p{margin:0 0 18px;font-size:14px;color:' + t.muted + ';line-height:1.5}' +
      'input,select{width:100%;padding:14px 16px;border:1px solid ' + t.line + ';border-radius:14px;font-size:16px;margin-bottom:10px;color:' + t.text + ';background:' + t.input + ';color-scheme:' + (dark ? 'dark' : 'light') + '}' +
      'input:focus,select:focus{outline:none;border-color:var(--c);box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 22%,transparent)}' +
      '.row{display:flex;gap:8px}.row select{flex:1}' +
      '.submit{width:100%;padding:15px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--c),color-mix(in srgb,var(--c) 70%,#ffffff));color:#fff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 12px 30px -10px var(--c);transition:transform .15s}' +
      '.submit:hover{transform:translateY(-1px)}' +
      '.submit:disabled{opacity:.6;cursor:wait}' +
      '.link{display:block;margin:14px auto 0;background:none;border:0;color:' + t.muted + ';font-size:13px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:0}' +
      '.link:hover{color:var(--c)}' +
      '.err{color:#ef4444;font-size:13px;margin:-4px 0 10px}' +
      '.consent{font-size:11px;color:' + t.muted + ';opacity:.75;margin-top:14px;line-height:1.4;text-align:center}' +
      '.ring{position:relative;width:150px;height:150px;margin:6px auto 14px}' +
      '.ring svg{transform:rotate(-90deg);overflow:visible}' +
      '.ring circle{fill:none;stroke-width:8}' +
      '.ring .bg{stroke:' + t.line + '}' +
      '.ring .fg{stroke:var(--c);stroke-linecap:round;transition:stroke-dashoffset 1s linear;filter:drop-shadow(0 0 8px var(--c))}' +
      '.timer{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:44px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}' +
      '.timer small{font-size:12px;font-weight:600;color:' + t.muted + ';letter-spacing:0}' +
      '.center{text-align:center}' +
      '.hp{position:absolute;left:-9999px}' +
      '</style>' +
      '<div class="panel" part="panel">' +
      '<button class="x" aria-label="Zamknij">&times;</button>' +
      '<div class="body"></div>' +
      '</div>' +
      '<button class="btn" aria-label="Zamów rozmowę"><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>' + (cfg.open ? '<span class="dot"></span>' : '') + '</button>';

    var panel = root.querySelector('.panel');
    var body = root.querySelector('.body');
    var done = false;
    var lastTrigger = 'button';

    function esc(s) { return String(s || '').replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

    function slotPicker() {
      var days = {};
      cfg.slots.forEach(function (s) { (days[s.day] = days[s.day] || []).push(s); });
      var names = Object.keys(days);
      if (!names.length) return '';
      return '<div class="row"><select class="day">' + names.map(function (d) { return '<option>' + esc(d) + '</option>'; }).join('') +
        '</select><select class="time"></select></div>';
      }

    function fillTimes() {
      var day = root.querySelector('.day'), time = root.querySelector('.time');
      if (!day) return;
      time.innerHTML = cfg.slots.filter(function (s) { return s.day === day.value; })
        .map(function (s) { return '<option value="' + s.at + '">' + esc(s.time) + '</option>'; }).join('');
    }

    function form(schedule, title) {
      var ttl = title || (schedule && !cfg.open ? cfg.offHoursTitle : cfg.title);
      var sub = schedule ? (cfg.open ? 'Wybierz dogodny termin rozmowy.' : cfg.offHoursSubtitle) : cfg.subtitle;
      body.innerHTML =
        (cfg.open ? '<span class="pill"><b></b>Konsultanci są online</span>' : '<span class="pill off"><b></b>Zaplanuj rozmowę</span>') +
        '<h3>' + esc(ttl) + '</h3><p>' + esc(sub) + '</p>' +
        '<form novalidate>' +
        '<input class="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Twój numer telefonu" required>' +
        '<input class="hp" name="website" tabindex="-1" autocomplete="off">' +
        (schedule ? slotPicker() : '') +
        '<div class="err"></div>' +
        '<button class="submit" type="submit">' + esc(schedule ? 'Umów rozmowę' : cfg.buttonText) + '</button>' +
        '</form>' +
        (cfg.open && cfg.slots.length ? '<button class="link">' + (schedule ? 'Zadzwońcie teraz' : 'Wolę inny termin') + '</button>' : '') +
        '<div class="consent">Zostawiając numer, zgadzasz się na jednorazowy kontakt telefoniczny w sprawie Twojego zapytania.</div>';
      if (schedule) { fillTimes(); root.querySelector('.day') && root.querySelector('.day').addEventListener('change', fillTimes); }
      var link = root.querySelector('.link');
      if (link) link.addEventListener('click', function () { form(!schedule); });
      root.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); submit(schedule); });
      setTimeout(function () { root.querySelector('.phone').focus(); }, 50);
    }

    function submit(schedule) {
      var phone = root.querySelector('.phone').value.trim();
      var err = root.querySelector('.err');
      if (phone.replace(/\D/g, '').length < 9) { err.textContent = 'Podaj poprawny numer telefonu'; return; }
      var btn = root.querySelector('.submit');
      btn.disabled = true;
      var time = root.querySelector('.time');
      post('/callback', {
        phone: phone,
        website: root.querySelector('.hp').value,
        scheduledAt: schedule && time ? time.value : undefined,
        pageUrl: location.href,
        referrer: store('cb_ref') || '',
        utm_source: store('cb_utm_source') || '', utm_medium: store('cb_utm_medium') || '', utm_campaign: store('cb_utm_campaign') || '',
        trigger: lastTrigger,
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
        if (!res.ok) { err.textContent = res.j.error || 'Coś poszło nie tak'; btn.disabled = false; return; }
        done = true;
        if (res.j.scheduled) {
          var when = new Date(res.j.scheduledAt).toLocaleString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
          body.innerHTML = '<span class="pill off"><b></b>Rozmowa zaplanowana</span><h3>' + esc(cfg.thankYouScheduled) + '</h3><p>Termin: <b style="color:var(--c)">' + esc(when) + '</b></p>';
        } else {
          var C = 2 * Math.PI * 66;
          body.innerHTML = '<div class="center"><h3 style="padding:0 30px">' + esc(cfg.thankYou) + '</h3>' +
            '<div class="ring"><svg width="150" height="150"><circle class="bg" cx="75" cy="75" r="66"/><circle class="fg" cx="75" cy="75" r="66" stroke-dasharray="' + C + '" stroke-dashoffset="0"/></svg>' +
            '<div class="timer"><span>30</span><small>sekund</small></div></div>' +
            '<p>Odbierz telefon. Nasz konsultant już do Ciebie dzwoni.</p></div>';
          var left = 30, el = root.querySelector('.timer span'), fg = root.querySelector('.fg');
          var iv = setInterval(function () {
            left--;
            el.textContent = Math.max(left, 0);
            fg.style.strokeDashoffset = C * (1 - Math.max(left, 0) / 30);
            if (left <= 0) clearInterval(iv);
          }, 1000);
        }
      }).catch(function () { err.textContent = 'Brak połączenia. Spróbuj ponownie.'; btn.disabled = false; });
    }

    function open(trigger, title) {
      if (panel.classList.contains('open')) return;
      lastTrigger = trigger;
      if (!done) form(!cfg.open, title);
      panel.classList.add('open');
      post('/event', { type: trigger === 'exit_intent' ? 'exit_intent' : 'open' });
    }
    function close() { panel.classList.remove('open'); store('cb_closed', '1'); }

    root.querySelector('.btn').addEventListener('click', function () { panel.classList.contains('open') ? close() : open('button'); });
    root.querySelector('.x').addEventListener('click', close);

    if (cfg.autoOpenSeconds > 0 && !store('cb_closed')) {
      setTimeout(function () { if (!store('cb_closed')) open('auto'); }, cfg.autoOpenSeconds * 1000);
    }
    if (cfg.exitIntent && window.matchMedia('(pointer:fine)').matches) {
      document.addEventListener('mouseout', function onOut(e) {
        if (e.relatedTarget || e.clientY > 10 || store('cb_exit') || done) return;
        store('cb_exit', '1');
        document.removeEventListener('mouseout', onOut);
        open('exit_intent', cfg.exitIntentTitle);
      });
    }
    document.body.appendChild(host);
  }
})();
