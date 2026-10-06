import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { blobKey, newId } from './crypto.js';

/**
 * Content-addressed, encrypted-at-rest blob store on local disk.
 * Each unique object is stored once (deduplicated by SHA-256) and encrypted with
 * AES-256-GCM under a per-blob key derived (HKDF) from the storage master key.
 * Replace with an S3-compatible backend for production scale; the interface stays the same.
 */
export class BlobStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  }

  pathFor(blobId) {
    return path.join(this.dir, blobId.slice(-2), blobId);
  }

  tmpDir() {
    return path.join(this.dir, 'tmp');
  }

  /** Hashes a plaintext temp file and returns { sha256, size, head } (head = first 4 KB for sniffing). */
  async inspect(tmpPath) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(tmpPath)) {
      hash.update(chunk);
      size += chunk.length;
      if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
    }
    return { sha256: hash.digest('hex'), size, head };
  }

  /** Encrypts a temp file into the store. Returns { id, iv, authTag }. */
  async put(tmpPath) {
    const id = newId('blob');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', blobKey(id), iv);
    const dest = this.pathFor(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(fs.createReadStream(tmpPath), cipher, fs.createWriteStream(dest, { mode: 0o600 }));
    return { id, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
  }

  /** Decrypting read stream. GCM authenticity is verified when the stream ends. */
  read(blob) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', blobKey(blob.id), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.auth_tag, 'base64'));
    const src = fs.createReadStream(this.pathFor(blob.id));
    src.on('error', (err) => decipher.destroy(err));
    return src.pipe(decipher);
  }

  async readAll(blob) {
    const chunks = [];
    for await (const c of this.read(blob)) chunks.push(c);
    return Buffer.concat(chunks);
  }

  remove(blobId) {
    fs.rmSync(this.pathFor(blobId), { force: true });
  }

  diskUsage() {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    try {
      walk(this.dir);
    } catch {
      /* ignore */
    }
    return total;
  }
}
