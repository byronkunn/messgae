import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, alice, bob, carol;
before(async () => {
  srv = await startServer();
  alice = srv.client();
  bob = srv.client();
  carol = srv.client();
  await alice.register('Alice', 'alice');
  await bob.register('Bob', 'bob');
  await carol.register('Carol', 'carol');
  // By default people can only be added to groups by their contacts.
  const denied = await alice.post('/api/conversations/groups', { name: 'Nope', memberIds: [bob.user.id] });
  assert.equal(denied.status, 403);
  await bob.put(`/api/users/${alice.user.id}/contact`);
});
after(async () => srv.stop());

test('direct messages: send, reply, react, edit, delete, pin, search', async () => {
  const dm = await alice.post('/api/conversations/dm', { userId: bob.user.id });
  assert.equal(dm.status, 200);
  const id = dm.data.conversation.id;
  const again = await bob.post('/api/conversations/dm', { userId: alice.user.id });
  assert.equal(again.data.conversation.id, id, 'the same DM is reused');

  const m1 = await alice.post(`/api/conversations/${id}/messages`, { body: 'Hi @bob check https://example.com/page' });
  assert.equal(m1.status, 201);
  assert.deepEqual(m1.data.message.links, ['https://example.com/page']);
  const m2 = await bob.post(`/api/conversations/${id}/messages`, { body: 'Hey!', replyToId: m1.data.message.id });
  assert.equal(m2.data.message.replyTo.id, m1.data.message.id);

  const notes = await bob.get('/api/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'mention'));

  assert.equal((await bob.put(`/api/messages/${m1.data.message.id}/reactions/${encodeURIComponent('👍')}`)).status, 200);
  assert.equal((await bob.put(`/api/messages/${m1.data.message.id}/reactions/notanemoji`)).status, 400);
  const edited = await alice.patch(`/api/messages/${m1.data.message.id}`, { body: 'Hi Bob (edited)' });
  assert.ok(edited.data.message.editedAt);
  assert.equal((await bob.patch(`/api/messages/${m1.data.message.id}`, { body: 'nope' })).status, 403);
  assert.equal((await bob.post(`/api/messages/${m1.data.message.id}/pin`)).status, 200);
  const pins = await alice.get(`/api/conversations/${id}/pins`);
  assert.equal(pins.data.messages.length, 1);

  const list = await alice.get(`/api/conversations/${id}/messages`);
  assert.equal(list.data.messages.length, 2);
  assert.equal(list.data.messages[0].reactions[0].emoji, '👍');

  const search = await alice.get(`/api/conversations/${id}/search?q=edited`);
  assert.equal(search.data.messages.length, 1);
  const links = await alice.get(`/api/conversations/${id}/gallery?kind=links`);
  assert.equal(links.data.links.length, 0, 'edited message no longer has links');

  assert.equal((await bob.del(`/api/messages/${m2.data.message.id}`)).status, 200);
  const after = await alice.get(`/api/conversations/${id}/messages`);
  assert.ok(after.data.messages[1].deletedAt);
  assert.equal(after.data.messages[1].body, '');

  // Outsiders cannot see the conversation at all.
  assert.equal((await carol.get(`/api/conversations/${id}/messages`)).status, 404);
  assert.equal((await carol.get(`/api/messages/${m1.data.message.id}`)).status, 404);
});

test('privacy: who can message me, and blocking', async () => {
  await carol.patch('/api/me/privacy', { whoCanMessage: 'contacts' });
  const denied = await alice.post('/api/conversations/dm', { userId: carol.user.id });
  assert.equal(denied.status, 403);
  await carol.put(`/api/users/${alice.user.id}/contact`);
  const allowed = await alice.post('/api/conversations/dm', { userId: carol.user.id });
  assert.equal(allowed.status, 200);
  const cid = allowed.data.conversation.id;
  await carol.put(`/api/users/${alice.user.id}/block`);
  const blocked = await alice.post(`/api/conversations/${cid}/messages`, { body: 'hello?' });
  assert.equal(blocked.status, 403);
  await carol.del(`/api/users/${alice.user.id}/block`);
  assert.equal((await alice.post(`/api/conversations/${cid}/messages`, { body: 'hello again' })).status, 201);
});

test('clear and delete conversation only affect my view', async () => {
  const dm = await alice.post('/api/conversations/dm', { userId: bob.user.id });
  const id = dm.data.conversation.id;
  await alice.post(`/api/conversations/${id}/clear`);
  assert.equal((await alice.get(`/api/conversations/${id}/messages`)).data.messages.length, 0);
  assert.ok((await bob.get(`/api/conversations/${id}/messages`)).data.messages.length > 0);
  await alice.del(`/api/conversations/${id}`);
  const list = await alice.get('/api/conversations');
  assert.ok(!list.data.conversations.some((c) => c.id === id));
});

test('group chats: roles, permissions, slow mode, kick, ban, invites', async () => {
  const g = await alice.post('/api/conversations/groups', { name: 'Weekend', memberIds: [bob.user.id] });
  assert.equal(g.status, 201);
  const id = g.data.conversation.id;
  assert.equal(g.data.conversation.myRole, 'owner');

  // Bob (member) cannot change settings; Alice makes him a moderator.
  assert.equal((await bob.patch(`/api/conversations/${id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await alice.patch(`/api/conversations/${id}/members/${bob.user.id}`, { role: 'moderator' })).status, 200);
  assert.equal((await bob.patch(`/api/conversations/${id}`, { slowModeSeconds: 30 })).status, 200);
  assert.equal((await bob.patch(`/api/conversations/${id}`, { name: 'Hacked' })).status, 403);

  // Carol joins through an invite link; slow mode applies to her but not moderators.
  const inv = await bob.post(`/api/conversations/${id}/invites`, { maxUses: 5 });
  assert.equal(inv.status, 201);
  const preview = await carol.get(`/api/invites/${inv.data.invite.code}`);
  assert.equal(preview.data.group.name, 'Weekend');
  assert.equal((await carol.post(`/api/invites/${inv.data.invite.code}/join`)).status, 200);
  assert.equal((await carol.post(`/api/conversations/${id}/messages`, { body: 'one' })).status, 201);
  const slow = await carol.post(`/api/conversations/${id}/messages`, { body: 'two' });
  assert.equal(slow.status, 429);
  assert.equal(slow.data.error.code, 'slow_mode');
  const modMsg = await bob.post(`/api/conversations/${id}/messages`, { body: 'mods skip slow mode' });
  assert.equal(modMsg.status, 201, JSON.stringify(modMsg.data));
  assert.equal((await bob.post(`/api/conversations/${id}/messages`, { body: 'again' })).status, 201);

  // Members cannot moderate; moderators cannot act on the owner.
  assert.equal((await carol.del(`/api/conversations/${id}/members/${bob.user.id}`)).status, 403);
  assert.equal((await bob.del(`/api/conversations/${id}/members/${alice.user.id}`)).status, 403);
  // Ban Carol, she loses access and cannot rejoin.
  assert.equal((await bob.post(`/api/conversations/${id}/bans`, { userId: carol.user.id, reason: 'spam' })).status, 200);
  assert.equal((await carol.get(`/api/conversations/${id}/messages`)).status, 404);
  assert.equal((await carol.post(`/api/invites/${inv.data.invite.code}/join`)).status, 403);

  const members = await alice.get(`/api/conversations/${id}/members`);
  assert.deepEqual(members.data.members.map((m) => m.role).sort(), ['moderator', 'owner']);
});

test('polls and stickers', async () => {
  const g = await alice.post('/api/conversations/groups', { name: 'Poll room', memberIds: [bob.user.id] });
  const id = g.data.conversation.id;
  const poll = await alice.post(`/api/conversations/${id}/messages`, { poll: { question: 'Pizza?', options: ['Yes', 'No'] } });
  assert.equal(poll.status, 201);
  const v = await bob.post(`/api/messages/${poll.data.message.id}/vote`, { option: 1 });
  assert.deepEqual(v.data.message.poll.votes, [0, 1]);
  assert.equal(v.data.message.poll.myVote, 1);
  const st = await bob.post(`/api/conversations/${id}/messages`, { sticker: 'wave' });
  assert.equal(st.data.message.kind, 'sticker');
});

test('muting a user suppresses their mention notifications', async () => {
  const g = await alice.post('/api/conversations/groups', { name: 'Mute room', memberIds: [bob.user.id] });
  const id = g.data.conversation.id;
  await bob.put(`/api/users/${alice.user.id}/mute`);
  const before = (await bob.get('/api/notifications')).data.notifications.length;
  await alice.post(`/api/conversations/${id}/messages`, { body: 'hey @bob are you there?' });
  assert.equal((await bob.get('/api/notifications')).data.notifications.length, before);
  await bob.del(`/api/users/${alice.user.id}/mute`);
  await alice.post(`/api/conversations/${id}/messages`, { body: 'now @bob?' });
  assert.equal((await bob.get('/api/notifications')).data.notifications.length, before + 1);
});

test('restricted accounts can only use direct messages', async () => {
  const g = await alice.post('/api/conversations/groups', { name: 'Restricted room', memberIds: [bob.user.id] });
  srv.ctx.db.run("UPDATE users SET state = 'restricted', state_until = ? WHERE id = ?", Date.now() + 3600_000, bob.user.id);
  const r = await bob.post(`/api/conversations/${g.data.conversation.id}/messages`, { body: 'hi' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'account_restricted');
  assert.equal((await bob.post('/api/spaces', { name: 'Nope Space' })).status, 403);
  const dm = await bob.post('/api/conversations/dm', { userId: alice.user.id });
  assert.equal((await bob.post(`/api/conversations/${dm.data.conversation.id}/messages`, { body: 'dm still works' })).status, 201);
  // Restrictions lift automatically when they expire.
  srv.ctx.db.run('UPDATE users SET state_until = ? WHERE id = ?', Date.now() - 1, bob.user.id);
  assert.equal((await bob.post(`/api/conversations/${g.data.conversation.id}/messages`, { body: 'back' })).status, 201);
});
