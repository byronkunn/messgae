// Rough performance check: builds a synthetic dataset and times hot API paths.
// Usage: node scripts/bench.js [users=20000] [messages=300000]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messgae-bench-'));
process.env.KEY_DIR = path.join(dir, 'keys');
process.env.SCRYPT_N = '1024';
const { createApp } = await import('../server/app.js');
const { totp } = await import('../server/lib/crypto.js');

const USERS = Number(process.argv[2] || 20000);
const MESSAGES = Number(process.argv[3] || 300000);
const { app, ctx, close } = createApp({ dataDir: dir });
const { db } = ctx;
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'x-requested-with': 'messgae', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.();
  if (set?.length) cookie = set[0].split(';')[0];
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${JSON.stringify(data)}`);
  return data;
}

console.log(`Building ${USERS} users and ${MESSAGES} messages...`);
const admin = await call('POST', '/api/auth/register', { displayName: 'Bench Admin', username: 'benchadmin' });
const { secret } = await call('POST', '/api/me/2fa/setup');
await call('POST', '/api/me/2fa/enable', { code: totp(secret) });
db.run("UPDATE users SET site_role = 'super_admin', evidence_access = 1 WHERE id = ?", admin.user.id);

const t0 = Date.now();
db.tx(() => {
  const now = Date.now();
  const insUser = db.raw.prepare('INSERT INTO users (id, account_id, username, display_name, recovery_verifier, recovery_rotated_at, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < USERS; i++) insUser.run(`usr_b${i}`, `9${String(i).padStart(23, "0")}`, `user${i}`, `User ${i}`, 'x', now, now - i * 1000, now - (i % 5000) * 60_000);
  const insConv = db.raw.prepare("INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)");
  const insMember = db.raw.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?,?,?)');
  const groups = 500;
  for (let g = 0; g < groups; g++) {
    insConv.run(`cnv_g${g}`, `Group ${g}`, `usr_b${g}`, now - g * 3600_000);
    for (let m = 0; m < 20; m++) insMember.run(`cnv_g${g}`, `usr_b${(g * 20 + m) % USERS}`, now);
  }
  insMember.run('cnv_g0', admin.user.id, now);
  const insMsg = db.raw.prepare("INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES (?,?,?,'text',?,?)");
  for (let i = 0; i < MESSAGES; i++) {
    const g = i % groups;
    insMsg.run(`msg_b${i}`, `cnv_g${g}`, `usr_b${(g * 20 + (i % 20)) % USERS}`, `benchmark message ${i}`, now - (MESSAGES - i) * 2000);
  }
  db.raw.exec(`UPDATE conversations SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id), last_message_at = (SELECT MAX(created_at) FROM messages WHERE conversation_id = conversations.id)`);
});
db.exec('ANALYZE');
console.log(`Data built in ${Date.now() - t0} ms\n`);

await call('POST', '/api/auth/elevate', { code: totp(secret, Date.now() + 30_000) });

async function time(label, fn, runs = 5) {
  const times = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    out = await fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(52)} median ${times[Math.floor(runs / 2)].toFixed(1).padStart(7)} ms`);
  return out;
}

const first = await time('Admin users page 1 (50)', () => call('GET', '/api/admin/users?pageSize=50'));
let cursor = first.nextCursor;
for (let i = 0; i < 100 && cursor; i++) cursor = (await call('GET', `/api/admin/users?pageSize=50&cursor=${cursor}`)).nextCursor;
await time('Admin users deep page via keyset cursor (~page 100)', () => call('GET', `/api/admin/users?pageSize=50&cursor=${cursor}`));
await time('Admin users search "user123"', () => call('GET', '/api/admin/users?q=user123'));
await time('Admin conversations sorted by activity', () => call('GET', '/api/admin/conversations?sort=last_message'));
await time('Admin conversation messages (evidence, page 1)', () => call('GET', '/api/admin/conversations/cnv_g0/messages?reason=benchmark%20run'));
await time('Admin communications dashboard (7d)', () => call('GET', '/api/admin/communications?range=7d'), 3);
await time('Admin analytics: messaging (30d)', () => call('GET', '/api/admin/analytics?section=messaging&range=30d'), 3);
await time('Admin global search', () => call('GET', '/api/admin/search?q=user42'));
await time('Chat list for a member', () => call('GET', '/api/conversations'));
const msgs = await time('Conversation history page (50)', () => call('GET', '/api/conversations/cnv_g0/messages'));
await time('Conversation history older page', () => call('GET', `/api/conversations/cnv_g0/messages?before=${msgs.beforeCursor}`));
await time('Send message', () => call('POST', '/api/conversations/cnv_g0/messages', { body: 'bench' }), 10);

server.close();
close();
fs.rmSync(dir, { recursive: true, force: true });
