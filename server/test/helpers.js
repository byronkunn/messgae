import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'messgae-test-'));
process.env.NODE_ENV = 'test';
process.env.SCRYPT_N = process.env.SCRYPT_N || '1024';
process.env.KEY_DIR = path.join(tmp, 'keys');
process.env.PUBLIC_ORIGIN = 'http://localhost:5173';

const { createApp } = await import('../app.js');
export const crypto = await import('../lib/crypto.js');

export async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const instance = createApp({ dataDir });
  const server = http.createServer(instance.app);
  instance.attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    ctx: instance.ctx,
    client: () => new Client(base),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      instance.close();
    },
  };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method, url, body, { headers = {}, raw = false, form } = {}) {
    const h = { 'x-requested-with': 'messgae', cookie: this.cookieHeader(), ...headers };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx);
      const v = pair.slice(idx + 1);
      if (!v) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    if (raw) return res;
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  get(url, opts) { return this.req('GET', url, undefined, opts); }
  post(url, body = {}, opts) { return this.req('POST', url, body, opts); }
  patch(url, body = {}, opts) { return this.req('PATCH', url, body, opts); }
  put(url, body = {}, opts) { return this.req('PUT', url, body, opts); }
  del(url, body, opts) { return this.req('DELETE', url, body, opts); }

  async register(displayName, username) {
    const r = await this.post('/api/auth/register', { displayName, username });
    if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
    this.user = r.data.user;
    this.accountId = r.data.accountId;
    this.recoveryKey = r.data.recoveryKey;
    return r.data;
  }

  async upload(filename, buffer, mime = 'application/octet-stream') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    return this.req('POST', '/api/files', undefined, { form });
  }
}

// Minimal valid file bodies for signature detection.
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'),
]);
export const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
export const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);

/** Promotes a user to staff directly in the DB and enables TOTP; returns the TOTP secret. */
export async function makeStaff(srv, client, role = 'site_admin', { evidence = false } = {}) {
  const setup = await client.post('/api/me/2fa/setup');
  const secret = setup.data.secret;
  const code = crypto.totp(secret);
  const en = await client.post('/api/me/2fa/enable', { code });
  if (en.status !== 200) throw new Error(JSON.stringify(en.data));
  srv.ctx.db.run('UPDATE users SET site_role = ?, evidence_access = ? WHERE id = ?', role, evidence ? 1 : 0, client.user.id);
  return secret;
}

/** Elevates a staff session using a TOTP code from the next time step (avoids replay rejection). */
export async function elevate(client, secret) {
  const code = crypto.totp(secret, Date.now() + 30_000);
  return client.post('/api/auth/elevate', { code });
}
