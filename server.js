// rail-web â€” relay + browser operator for the bench agent.
// No dependencies: hand-rolled WebSocket, room-based piping, end-to-end sealed frames.
//
//   agent  ->  wss://host/agent?room=X&key=K   (raw frames, exactly like the funnel did)
//   browser->  wss://host/op?room=X&key=K      (same frames, prefixed with a 4 byte slot)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.ROOM_TOKEN || '';
const PUB = path.join(process.cwd(), 'public');

// ---------------------------------------------------------------- websocket

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[0] = 0x80 | opcode;
    head[1] = len;
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class Peer {
  constructor(socket, role) {
    this.socket = socket;
    this.role = role;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.alive = true;
    this.handlers = { message: null, close: null };
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.end(); } catch { }
    if (this.handlers.close) this.handlers.close();
  }

  send(payload, opcode = 0x2) {
    if (!this.alive) return;
    try {
      if (this.socket.writableLength > 8 * 1024 * 1024) return; // never queue the ocean
      this.socket.write(encodeFrame(payload, opcode));
    } catch { this.close(); }
  }

  sendText(s) { this.send(Buffer.from(s, 'utf8'), 0x1); }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (; ;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        len = Number(this.buf.readBigUInt64BE(off));
        off += 8;
      }
      if (len > 32 * 1024 * 1024) { this.close(); return; }

      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4);
        off += 4;
      }
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

      if (opcode === 0x0) {
        this.frag.push(payload);
      } else {
        this.frag = [payload];
      }
      if (!fin) continue;

      const msg = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
      this.frag = [];
      if (this.handlers.message) this.handlers.message(msg);
    }
  }
}

// ---------------------------------------------------------------- rooms

const rooms = new Map();

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { op: null, agents: new Map(), next: 1 };
    rooms.set(name, r);
  }
  return r;
}

function dropRoomIfEmpty(name, r) {
  if (!r.op && r.agents.size === 0) rooms.delete(name);
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok ' + rooms.size);
    return;
  }

  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const role = url.pathname === '/agent' ? 'agent' : url.pathname === '/op' ? 'op' : null;
  if (!role) { socket.destroy(); return; }
  if (TOKEN && url.searchParams.get('key') !== TOKEN) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const roomName = (url.searchParams.get('room') || 'default').slice(0, 64);
  const r = getRoom(roomName);
  const peer = new Peer(socket, role);

  if (role === 'agent') {
    const slot = r.next++;
    r.agents.set(slot, peer);
    console.log(`[${roomName}] agent ${slot} up (${r.agents.size})`);
    if (r.op) r.op.sendText('A ' + slot);

    peer.on('message', (msg) => {
      if (!peer.first) peer.first = Buffer.from(msg);   // keep the handshake nonce
      const op = r.op;
      if (!op || !op.alive) return;
      const out = Buffer.allocUnsafe(4 + msg.length);
      out.writeUInt32BE(slot, 0);
      msg.copy(out, 4);
      op.send(out);
    });

    peer.on('close', () => {
      r.agents.delete(slot);
      console.log(`[${roomName}] agent ${slot} down (${r.agents.size})`);
      if (r.op) r.op.sendText('R ' + slot);
      dropRoomIfEmpty(roomName, r);
    });
  } else {
    const old = r.op;
    r.op = peer;
    if (old && old.alive) old.close();
    console.log(`[${roomName}] operator up (${r.agents.size} agents)`);

    for (const [slot, agent] of r.agents) {
      peer.sendText('A ' + slot);
      if (agent.first) {
        const out = Buffer.allocUnsafe(4 + agent.first.length);
        out.writeUInt32BE(slot, 0);
        agent.first.copy(out, 4);
        peer.send(out);
      }
    }

    peer.on('message', (msg) => {
      if (msg.length < 5) return;
      const slot = msg.readUInt32BE(0);
      const target = r.agents.get(slot);
      if (!target) return;
      target.send(msg.subarray(4));
    });

    peer.on('close', () => {
      if (r.op !== peer) return;
      r.op = null;
      console.log(`[${roomName}] operator down — closing ${r.agents.size} agents`);
      for (const agent of r.agents.values()) agent.close();
      dropRoomIfEmpty(roomName, r);
    });
  }
});

server.listen(PORT, () => console.log('rail-web on :' + PORT + (TOKEN ? ' (token)' : ' (open)')));
