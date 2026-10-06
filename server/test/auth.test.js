import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv;
before(async () => (srv = await startServer()));
after(async () => srv.stop());

test('private account creation returns account id and a recovery key shown once', async () => {
  const c = srv.client();
  const data = await c.register('Alice', 'alice');
  assert.match(data.accountId, /^\d{4}( \d{4}){5}$/);
  assert.match(data.recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, 'alice');
  // Raw recovery key is never stored.
  const row = srv.ctx.db.get('SELECT * FROM users WHERE username = ?', 'alice');
  assert.ok(!JSON.stringify(row).includes(data.recoveryKey.replace(/-/g, '')));
  assert.match(row.recovery_verifier, /^scrypt\$/);
});

test('sign in with account id + recovery key, wrong key fails, lockout engages', async () => {
  const a = srv.client();
  const { accountId, recoveryKey } = await a.register('Bob', 'bob');
  const b = srv.client();
  const ok = await b.post('/api/auth/login', { accountId, recoveryKey: recoveryKey.toLowerCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.username, 'bob');

  const bad = srv.client();
  const wrong = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
  for (let i = 0; i < 5; i++) {
    const r = await bad.post('/api/auth/login', { accountId, recoveryKey: wrong });
    assert.equal(r.status, 401);
  }
  const locked = await bad.post('/api/auth/login', { accountId, recoveryKey });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error.code, 'locked');
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const res = await fetch(`${srv.base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'X' }),
  });
  assert.equal(res.status, 403);
});

test('recovery key regeneration invalidates the previous key', async () => {
  const c = srv.client();
  const { accountId, recoveryKey } = await c.register('Carol', 'carol');
  const denied = await c.post('/api/me/recovery/regenerate', {});
  assert.equal(denied.status, 403);
  const r = await c.post('/api/me/recovery/regenerate', { currentRecoveryKey: recoveryKey });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.recoveryKey, recoveryKey);
  const old = await srv.client().post('/api/auth/login', { accountId, recoveryKey });
  assert.equal(old.status, 401);
  const fresh = await srv.client().post('/api/auth/login', { accountId, recoveryKey: r.data.recoveryKey });
  assert.equal(fresh.status, 200);
});

test('device management: list sessions and revoke another device', async () => {
  const phone = srv.client();
  const { accountId, recoveryKey } = await phone.register('Dana', 'dana');
  const laptop = srv.client();
  await laptop.post('/api/auth/login', { accountId, recoveryKey, deviceName: 'Work laptop' });
  const list = await phone.get('/api/me/sessions');
  assert.equal(list.data.sessions.length, 2);
  const other = list.data.sessions.find((s) => !s.current);
  assert.equal(other.deviceName, 'Work laptop');
  assert.equal((await phone.del(`/api/me/sessions/${other.id}`)).status, 200);
  assert.equal((await laptop.get('/api/me')).status, 401);
});

test('device linking: new device is approved from a signed-in device', async () => {
  const trusted = srv.client();
  await trusted.register('Eve', 'eve');
  const fresh = srv.client();
  const start = await fresh.post('/api/auth/link/start', { deviceName: 'Tablet' });
  assert.equal(start.status, 200);
  assert.equal((await fresh.post('/api/auth/link/poll', { pollToken: start.data.pollToken })).data.status, 'pending');
  const info = await trusted.get(`/api/auth/link/${start.data.code}`);
  assert.equal(info.data.deviceName, 'Tablet');
  assert.equal((await trusted.post(`/api/auth/link/${start.data.code}/approve`)).status, 200);
  const done = await fresh.post('/api/auth/link/poll', { pollToken: start.data.pollToken });
  assert.equal(done.data.status, 'approved');
  assert.equal((await fresh.get('/api/me')).data.user.username, 'eve');
  // The poll token cannot be reused.
  assert.equal((await srv.client().post('/api/auth/link/poll', { pollToken: start.data.pollToken })).status, 404);
});

test('profile and privacy settings', async () => {
  const c = srv.client();
  await c.register('Frank', 'frank');
  const p = await c.patch('/api/me/profile', { bio: 'Hello', statusEmoji: '🚗', statusText: 'Driving', links: [{ url: 'https://example.com' }] });
  assert.equal(p.status, 200);
  assert.equal(p.data.user.bio, 'Hello');
  assert.equal((await c.patch('/api/me/profile', { links: [{ url: 'javascript:alert(1)' }] })).status, 400);
  const pr = await c.patch('/api/me/privacy', { onlineStatus: 'nobody', whoCanMessage: 'contacts' });
  assert.equal(pr.data.privacy.onlineStatus, 'nobody');
  assert.equal((await c.patch('/api/me/privacy', { onlineStatus: 'sometimes' })).status, 400);
  const viewer = srv.client();
  await viewer.register('Gina', 'gina');
  const prof = await viewer.get(`/api/users/${c.user.id}`);
  assert.equal(prof.data.user.online, undefined);
  assert.equal(prof.data.user.canMessage, false);
});
