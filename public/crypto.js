// Shared crypto for the browser operator. Same scheme as the C# agent:
//   handshake: agent nonce -> operator nonce + HMAC(key,"op"|na|nb) -> agent HMAC(key,"ag"|na|nb)
//   frames   : AES-256-CBC + HMAC-SHA256 over iv|ciphertext, PKCS7 padding

const enc = new TextEncoder();

export function b64ToBytes(s) {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function utf8(s) { return enc.encode(s); }

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function hmac(keyBytes, ...parts) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = parts.length === 1 ? parts[0] : concat(...parts);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

// WebCrypto AES-CBC pads (PKCS#7) on encrypt and strips on decrypt by itself.
// Doing it manually would double-pad and corrupt every frame.

export class Channel {
  constructor(encKey, macKey) {
    this.encKey = encKey;
    this.macKey = macKey;
  }

  async seal(plain) {
    const iv = randomBytes(16);
    const key = await crypto.subtle.importKey('raw', this.encKey, { name: 'AES-CBC' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));
    const tag = await hmac(this.macKey, iv, ct);
    return concat(iv, ct, tag);
  }

  async open(blob) {
    if (blob.length < 16 + 32 + 16) throw new Error('short');
    const iv = blob.subarray(0, 16);
    const ct = blob.subarray(16, blob.length - 32);
    const tag = blob.subarray(blob.length - 32);
    const want = await hmac(this.macKey, iv, ct);
    if (!equal(want, tag)) throw new Error('mac');
    const key = await crypto.subtle.importKey('raw', this.encKey, { name: 'AES-CBC' }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct));
  }
}

export async function makeChannel(master, na, nb) {
  const encKey = await hmac(master, utf8('chan-enc'), na, nb);
  const macKey = await hmac(master, utf8('chan-mac'), na, nb);
  return new Channel(encKey, macKey);
}
