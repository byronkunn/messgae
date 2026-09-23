import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, owner, admin, mod, member, outsider;
let spaceId, channels, roles;

before(async () => {
  srv = await startServer();
  [owner, admin, mod, member, outsider] = [srv.client(), srv.client(), srv.client(), srv.client(), srv.client()];
  await owner.register('Owner', 'owner1');
  await admin.register('Admin', 'admin1');
  await mod.register('Mod', 'mod1');
  await member.register('Member', 'member1');
  await outsider.register('Outsider', 'outsider1');
});
after(async () => srv.stop());

const byName = (name) => channels.find((c) => c.name === name);

test('create a Space with default categories, channels and roles', async () => {
  const s = await owner.post('/api/spaces', { name: 'JDM Garage', visibility: 'public', discoverable: true, joinMode: 'open', topic: 'cars' });
  assert.equal(s.status, 201);
  spaceId = s.data.space.id;
  const d = await owner.get(`/api/spaces/${spaceId}`);
  channels = d.data.channels;
  roles = d.data.roles;
  assert.deepEqual(d.data.categories.map((c) => c.name), ['INFORMATION', 'GENERAL']);
  assert.deepEqual(channels.map((c) => c.name).sort(), ['announcements', 'general', 'media', 'rules']);
  assert.deepEqual(roles.map((r) => r.systemKey), ['admin', 'moderator', 'everyone']);
  for (const c of [admin, mod, member]) assert.equal((await c.post(`/api/spaces/${spaceId}/join`)).data.status, 'joined');
  const role = (k) => roles.find((r) => r.systemKey === k).id;
  assert.equal((await owner.put(`/api/spaces/${spaceId}/members/${admin.user.id}/roles`, { roleIds: [role('admin')] })).status, 200);
  assert.equal((await admin.put(`/api/spaces/${spaceId}/members/${mod.user.id}/roles`, { roleIds: [role('moderator')] })).status, 200);
  // A Space Admin cannot appoint other administrators — only the owner can.
  assert.equal((await admin.put(`/api/spaces/${spaceId}/members/${member.user.id}/roles`, { roleIds: [role('admin')] })).status, 403);
});

test('Space Admin does not grant any site permission', async () => {
  const r = await admin.get('/api/admin/overview');
  assert.equal(r.status, 403);
});

test('announcement channel: everyone reads, only staff post', async () => {
  const ann = byName('announcements');
  assert.equal((await member.post(`/api/conversations/${ann.id}/messages`, { body: 'hi' })).status, 403);
  assert.equal((await mod.post(`/api/conversations/${ann.id}/messages`, { body: 'Welcome!' })).status, 201);
  const read = await member.get(`/api/conversations/${ann.id}/messages`);
  assert.equal(read.data.messages[0].body, 'Welcome!');
  const gen = byName('general');
  assert.equal((await member.post(`/api/conversations/${gen.id}/messages`, { body: 'hello general' })).status, 201);
});

test('media channel requires attachments', async () => {
  const media = byName('media');
  const r = await member.post(`/api/conversations/${media.id}/messages`, { body: 'text only' });
  assert.equal(r.status, 400);
});

test('private channel visible only to selected roles', async () => {
  const modRole = roles.find((r) => r.systemKey === 'moderator').id;
  const created = await admin.post(`/api/spaces/${spaceId}/channels`, { name: 'Moderators', isPrivate: true, allowedRoleIds: [modRole] });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const seen = async (c) => (await c.get(`/api/spaces/${spaceId}`)).data.channels.some((x) => x.id === id);
  assert.equal(await seen(mod), true);
  assert.equal(await seen(admin), true);
  assert.equal(await seen(member), false);
  assert.equal((await member.get(`/api/conversations/${id}/messages`)).status, 404);
  assert.equal((await mod.post(`/api/conversations/${id}/messages`, { body: 'staff only' })).status, 201);
});

test('custom role + channel override (#vip for VIP+)', async () => {
  const vip = await admin.post(`/api/spaces/${spaceId}/roles`, { name: 'VIP', color: '#aa66ff' });
  assert.equal(vip.status, 201);
  const ch = await admin.post(`/api/spaces/${spaceId}/channels`, { name: 'vip', isPrivate: true, allowedRoleIds: [vip.data.role.id] });
  assert.equal((await member.get(`/api/conversations/${ch.data.id}/messages`)).status, 404);
  await admin.put(`/api/spaces/${spaceId}/members/${member.user.id}/roles`, { roleIds: [vip.data.role.id] });
  assert.equal((await member.get(`/api/conversations/${ch.data.id}/messages`)).status, 200);
  // Deny sending for VIP in that channel via an explicit override.
  const SEND = 1 << 1;
  assert.equal((await admin.put(`/api/spaces/${spaceId}/channels/${ch.data.id}/permissions`, { targetType: 'role', targetId: vip.data.role.id, allow: 1, deny: SEND })).status, 200);
  assert.equal((await member.post(`/api/conversations/${ch.data.id}/messages`, { body: 'x' })).status, 403);
});

test('forum channel: topics and replies, moderators lock topics', async () => {
  const f = await admin.post(`/api/spaces/${spaceId}/channels`, { name: 'help', type: 'forum' });
  const id = f.data.id;
  assert.equal((await member.post(`/api/conversations/${id}/messages`, { body: 'not in a topic' })).status, 400);
  const t = await member.post(`/api/conversations/${id}/threads`, { title: 'Engine swap?', body: 'K20 into EG?' });
  assert.equal(t.status, 201);
  const threadId = t.data.thread.id;
  assert.equal((await mod.post(`/api/conversations/${id}/messages`, { body: 'Yes!', threadId })).status, 201);
  const list = await member.get(`/api/conversations/${id}/threads`);
  assert.equal(list.data.threads[0].messageCount, 2);
  assert.equal((await member.patch(`/api/conversations/${id}/threads/${threadId}`, { locked: true })).status, 403);
  assert.equal((await mod.patch(`/api/conversations/${id}/threads/${threadId}`, { locked: true })).status, 200);
  assert.equal((await member.post(`/api/conversations/${id}/messages`, { body: 'more', threadId })).status, 403);
});

test('moderation: timeout, kick, ban, hierarchy', async () => {
  const gen = byName('general');
  assert.equal((await mod.post(`/api/spaces/${spaceId}/members/${member.user.id}/timeout`, { minutes: 10 })).status, 200);
  assert.equal((await member.post(`/api/conversations/${gen.id}/messages`, { body: 'muted?' })).status, 403);
  await mod.post(`/api/spaces/${spaceId}/members/${member.user.id}/timeout`, { minutes: 0 });
  assert.equal((await member.post(`/api/conversations/${gen.id}/messages`, { body: 'back' })).status, 201);
  // Moderator cannot act on the admin above them, or the owner.
  assert.equal((await mod.del(`/api/spaces/${spaceId}/members/${admin.user.id}`)).status, 403);
  assert.equal((await admin.del(`/api/spaces/${spaceId}/members/${owner.user.id}`)).status, 403);
  // Moderators have no ban permission by default; admins do.
  assert.equal((await mod.post(`/api/spaces/${spaceId}/bans`, { userId: member.user.id })).status, 403);
  assert.equal((await admin.post(`/api/spaces/${spaceId}/bans`, { userId: member.user.id, reason: 'test' })).status, 200);
  assert.equal((await member.post(`/api/spaces/${spaceId}/join`)).status, 403);
  await admin.del(`/api/spaces/${spaceId}/bans/${member.user.id}`);
  assert.equal((await member.post(`/api/spaces/${spaceId}/join`)).data.status, 'joined');
});

test('explore lists discoverable public Spaces only; preview before joining', async () => {
  await owner.post('/api/spaces', { name: 'Secret Club', visibility: 'private' });
  const ex = await outsider.get('/api/explore?tab=spaces&q=garage');
  assert.equal(ex.data.items.length, 1);
  assert.equal(ex.data.items[0].name, 'JDM Garage');
  const hidden = await outsider.get('/api/explore?tab=spaces&q=secret');
  assert.equal(hidden.data.items.length, 0);
  const prev = await outsider.get(`/api/spaces/${spaceId}`);
  assert.equal(prev.status, 200);
  assert.equal(prev.data.space.isMember, false);
  assert.ok(!prev.data.channels.some((c) => c.isPrivate));
  const gen = byName('general');
  const msgs = await outsider.get(`/api/conversations/${gen.id}/messages`);
  assert.equal(msgs.status, 200, 'public Space channels can be previewed');
  assert.equal((await outsider.post(`/api/conversations/${gen.id}/messages`, { body: 'x' })).status, 403);
  const topics = await outsider.get('/api/explore?tab=topics');
  assert.equal(topics.data.topics.find((t) => t.topic === 'cars').spaces, 1);
});

test('space reports reach space moderators; ownership transfer', async () => {
  const gen = byName('general');
  const m = await member.post(`/api/conversations/${gen.id}/messages`, { body: 'buy cheap followers' });
  const rep = await outsider.post('/api/reports', { targetType: 'message', targetId: m.data.message.id, reason: 'spam' });
  assert.equal(rep.status, 404, 'outsiders can only report what they can see');
  await outsider.post(`/api/spaces/${spaceId}/join`);
  const rep2 = await outsider.post('/api/reports', { targetType: 'message', targetId: m.data.message.id, reason: 'spam', details: 'spam link' });
  assert.equal(rep2.status, 201);
  const q = await mod.get(`/api/spaces/${spaceId}/reports`);
  assert.equal(q.data.reports.length, 1);
  assert.equal(q.data.reports[0].evidence.message.body, 'buy cheap followers');
  assert.equal((await member.get(`/api/spaces/${spaceId}/reports`)).status, 403);

  assert.equal((await admin.post(`/api/spaces/${spaceId}/transfer`, { userId: admin.user.id })).status, 403);
  assert.equal((await owner.post(`/api/spaces/${spaceId}/transfer`, { userId: admin.user.id })).status, 200);
  assert.equal((await admin.get(`/api/spaces/${spaceId}`)).data.space.isOwner, true);
});
