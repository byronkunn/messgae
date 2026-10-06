// Creates demo data: users, contacts, DMs, a group, a public Space and files.
// Prints the credentials for each demo account. Run against a fresh data directory.
import http from 'node:http';
import { createApp } from '../server/app.js';
import { totp } from '../server/lib/crypto.js';

const { app, ctx, attachRealtime, close } = createApp();
const server = http.createServer(app);
attachRealtime(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, path, body, form) {
    const headers = { 'x-requested-with': 'messgae', cookie: this.cookie };
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  upload(name, buf) {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    return this.req('POST', '/api/files', undefined, form);
  }
}

if (ctx.db.value('SELECT COUNT(*) FROM users') > 0) {
  console.error('Database already has users; seed expects a fresh DATA_DIR.');
  process.exit(1);
}

const people = {};
const creds = [];
for (const [username, displayName] of [['admin', 'Site Admin'], ['alex', 'Alex Rivera'], ['sam', 'Sam Chen'], ['jordan', 'Jordan Lee'], ['mod', 'Moderator Mo']]) {
  const c = new Client();
  const r = await c.req('POST', '/api/auth/register', { displayName, username: username === 'admin' ? 'siteadmin' : username === 'mod' ? 'modmo' : username });
  c.user = r.user;
  people[username] = c;
  creds.push({ username: r.user.username, accountId: r.accountId, recoveryKey: r.recoveryKey });
}

// Staff: admin (super admin + evidence access) and a moderator, both with 2FA.
const secrets = {};
for (const [key, role, evidence] of [['admin', 'super_admin', 1], ['mod', 'site_moderator', 0]]) {
  const c = people[key];
  const { secret } = await c.req('POST', '/api/me/2fa/setup');
  await c.req('POST', '/api/me/2fa/enable', { code: totp(secret) });
  ctx.db.run('UPDATE users SET site_role = ?, evidence_access = ? WHERE id = ?', role, evidence, c.user.id);
  secrets[c.user.username] = secret;
}

const { alex, sam, jordan } = people;
for (const [a, b] of [[alex, sam], [sam, alex], [alex, jordan], [jordan, alex], [sam, jordan], [jordan, sam]]) {
  await a.req('PUT', `/api/users/${b.user.id}/contact`);
}
await alex.req('PATCH', '/api/me/profile', { bio: 'Weekend track days, K-series swaps and too many browser tabs.', statusEmoji: '🏎️', statusText: 'At the garage' });

const dm = await alex.req('POST', '/api/conversations/dm', { userId: sam.user.id });
const dmId = dm.conversation.id;
await alex.req('POST', `/api/conversations/${dmId}/messages`, { body: 'Hey Sam! Did you get the build working?' });
const r1 = await sam.req('POST', `/api/conversations/${dmId}/messages`, { body: 'Almost — uploading the project now 👇' });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 1)]);
const proj = await sam.upload('Project.zip', zip);
await sam.req('POST', `/api/conversations/${dmId}/messages`, { fileIds: [proj.file.id], replyToId: r1.message.id });
await alex.req('PUT', `/api/messages/${r1.message.id}/reactions/${encodeURIComponent('🔥')}`);

const group = await alex.req('POST', '/api/conversations/groups', { name: 'Weekend Crew', description: 'Plans for Saturday', memberIds: [sam.user.id, jordan.user.id] });
await jordan.req('POST', `/api/conversations/${group.conversation.id}/messages`, { body: 'Who is driving on Saturday? @alex' });
await alex.req('POST', `/api/conversations/${group.conversation.id}/messages`, { poll: { question: 'Meet up where?', options: ['Café', 'Track', 'Garage'] } });

const space = await alex.req('POST', '/api/spaces', { name: 'JDM Garage', description: 'Builds, swaps and weekend meets for Japanese car fans.', visibility: 'public', discoverable: true, joinMode: 'open', topic: 'cars' });
const sid = space.space.id;
await alex.req('POST', `/api/spaces/${sid}/categories`, { name: 'CARS' });
const detail = await alex.req('GET', `/api/spaces/${sid}`);
const cars = detail.categories.find((c) => c.name === 'CARS');
for (const n of ['honda', 'toyota', 'nissan']) await alex.req('POST', `/api/spaces/${sid}/channels`, { name: n, categoryId: cars.id });
await alex.req('POST', `/api/spaces/${sid}/channels`, { name: 'build-logs', type: 'forum', categoryId: cars.id });
for (const c of [sam, jordan, people.mod]) await c.req('POST', `/api/spaces/${sid}/join`);
const d2 = await alex.req('GET', `/api/spaces/${sid}`);
const general = d2.channels.find((c) => c.name === 'general');
const ann = d2.channels.find((c) => c.name === 'announcements');
await alex.req('POST', `/api/conversations/${ann.id}/messages`, { body: 'Welcome to JDM Garage! Read #rules and share your builds.' });
await sam.req('POST', `/api/conversations/${general.id}/messages`, { body: 'First track day of the season is next weekend 🏁' });
const img = await jordan.upload('photo.png', png);
const media = d2.channels.find((c) => c.name === 'media');
await jordan.req('POST', `/api/conversations/${media.id}/messages`, { body: 'My EG hatch', fileIds: [img.file.id] });
const forum = d2.channels.find((c) => c.name === 'build-logs');
await sam.req('POST', `/api/conversations/${forum.id}/threads`, { title: 'K20 swap into EG — log', body: 'Starting the swap this week. Parts list inside.' });
await jordan.req('POST', '/api/reports', { targetType: 'message', targetId: r1.message.id, reason: 'spam', details: 'Demo report' }).catch(() => {});
const spam = await jordan.req('POST', `/api/conversations/${general.id}/messages`, { body: 'Buy cheap followers at example.com!!!' });
await sam.req('POST', '/api/reports', { targetType: 'message', targetId: spam.message.id, reason: 'spam', details: 'Looks like spam' });

const link = await sam.req('POST', `/api/files/${proj.file.id}/links`, { audience: 'anyone', expiresInHours: 168 });

console.log('\nDemo accounts (Account ID / Recovery Key):\n');
for (const c of creds) console.log(`  @${c.username.padEnd(10)} ${c.accountId}  ${c.recoveryKey}`);
console.log('\nStaff 2FA secrets (add to an authenticator app):');
for (const [u, s] of Object.entries(secrets)) console.log(`  @${u}: ${s}`);
console.log(`\nPublic share link: ${link.link.url}\n`);

server.close();
close();
