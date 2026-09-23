// All cryptography here uses Node's built-in, well-reviewed primitives
// (CSPRNG, scrypt, SHA-256, HMAC, AES-256-GCM). Nothing is home-grown.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomBase32(chars) {
  const bytes = crypto.randomBytes(chars);
  let out = '';
  for (let i = 0; i < chars; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/** Opaque, unguessable identifier (~120 bits) with a readable type prefix. */
export function newId(prefix) {
  return `${prefix}_${randomBase32(24).toLowerCase()}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 24-digit public Account ID, e.g. "4829 1938 5721 6304 8291 4752". Not a secret. */
export function generateAccountId() {
  let digits = String(crypto.randomInt(1, 10));
  for (let i = 1; i < 24; i++) digits += String(crypto.randomInt(0, 10));
  return digits;
}

export function formatAccountId(id) {
  return String(id).replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function normalizeAccountId(input) {
  return String(input || '').replace(/\D/g, '');
}

/** 32 Crockford base32 chars (160 bits of entropy) grouped as XXXX-XXXX-... */
export function generateRecoveryKey() {
  return randomBase32(32).match(/.{4}/g).join('-');
}

export function normalizeRecoveryKey(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

// ---------------------------------------------------------------------------
// Password-style verifiers (scrypt). Used for recovery keys and file passwords.
// Stored as "scrypt$N$r$p$salt$hash" so parameters can be raised later.

export function makeVerifier(secret) {
  const N = config.scryptN, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkVerifier(secret, verifier) {
  if (!verifier || typeof verifier !== 'string') return false;
  const [alg, n, r, p, saltB64, hashB64] = verifier.split('$');
  if (alg !== 'scrypt') return false;
  const N = Number(n), R = Number(r), P = Number(p);
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length, {
    N, r: R, p: P, maxmem: 256 * N * R,
  });
  return crypto.timingSafeEqual(expected, actual);
}

// A verifier computed once so that failed lookups (unknown account) cost the same time.
let dummyVerifier;
export function dummyCheck(secret) {
  dummyVerifier ||= makeVerifier('dummy-secret-for-timing');
  checkVerifier(secret, dummyVerifier);
  return false;
}

// ---------------------------------------------------------------------------
// Key management. Each purpose has its own 256-bit key kept outside the database.

const keyCache = new Map();

export function getKey(name) {
  if (keyCache.has(name)) return keyCache.get(name);
  const fromEnv = config.keys[name];
  let key;
  if (fromEnv) {
    key = Buffer.from(fromEnv, 'base64');
  } else {
    if (config.isProd) {
      throw new Error(`Missing encryption key "${name}". Set it via environment/secret manager in production.`);
    }
    fs.mkdirSync(config.keyDir, { recursive: true, mode: 0o700 });
    const file = path.join(config.keyDir, `${name}.key`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error(`Encryption key "${name}" must be 32 bytes (base64).`);
  keyCache.set(name, key);
  return key;
}

/** AES-256-GCM seal of a small secret. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function seal(keyName, plaintext, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(keyName), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(keyName, sealed, aad = '') {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('Unsupported sealed format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(keyName), Buffer.from(iv, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Per-blob key derived with HKDF from the storage master key. */
export function blobKey(blobId) {
  return Buffer.from(crypto.hkdfSync('sha256', getKey('storage'), Buffer.alloc(0), `blob:${blobId}`, 32));
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, HMAC-SHA1, 30s, 6 digits) for staff two-factor authentication.

export function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totp(secretB32, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accepts the current code and one step either side for clock drift. Returns the matched counter or null. */
export function verifyTotp(secretB32, code, time = Date.now()) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return null;
  for (const drift of [0, -1, 1]) {
    const t = time + drift * 30_000;
    if (timingSafeEqualStr(totp(secretB32, t), clean)) return Math.floor(t / 30_000);
  }
  return null;
}
