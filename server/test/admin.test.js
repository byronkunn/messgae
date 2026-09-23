import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeStaff, elevate, ZIP } from './helpers.js';

let srv, superAdmin, admin, moderator, alice, bob;
let adminSecret, superSecret;
let dmId, fileId, msgId;

before(async () => {
  srv = await startServer();
  [superAdmin, admin, moderator, alice, bob] = [srv.client(), srv.client(), srv.client(), srv.client(), srv.client()];
  await superAdmin.register('Root', 'root1');
  await admin.register('Adam', 'adam');
  await moderator.register('Mona', 'mona');
  await alice.register('Alice', 'alice');
  await bob.register('Bob', 'bob');
  superSecret = await makeStaff(srv, superAdmin, 'super_admin');
  adminSecret = await makeStaff(srv, admin, 'site_admin', { evidence: true });
  await makeStaff(srv, moderator, 'site_moderator');

  const dm = await alice.post('/api/conversations/dm', { userId: bob.user.id });
  dmId = dm.data.conversation.id;
  const up = await alice.upload('project.zip', ZIP);
  fileId = up.data.file.id;
  await alice.put(`/api/files/${fileId}/password`, { password: 'swordfish' });
  const m = await alice.post(`/api/conversations/${dmId}/messages`, { body: 'here is the build', fileIds: [fileId] });
  msgId = m.data.message.id;
  await bob.post(`/api/conversations/${dmId}/messages`, { body: 'thanks' });
});
after(async () => srv.stop());

test('regular users and staff without 2FA cannot use admin', async () => {
  assert.equal((await alice.get('/api/admin/overview')).status, 403);
  const noTotp = srv.client();
  await noTotp.register('Staffer', 'staffer');
  srv.ctx.db.run("UPDATE users SET site_role = 'site_admin' WHERE id = ?", noTotp.user.id);
  const r = await noTotp.get('/api/admin/overview');
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'staff_2fa_required');
});

test('user list uses server-side pagination with keyset cursors', async () => {
  for (let i = 0; i < 30; i++) srv.ctx.db.run(
    "INSERT INTO users (id, account_id, username, display_name, recovery_verifier, recovery_rotated_at, created_at) VALUES (?,?,?,?,?,?,?)",
    `usr_bulk${i}`, String(100000000000000000000000n + BigInt(i)), `bulk${i}`, `Bulk ${i}`, 'x', 0, 1000 + i,
  );
  const p1 = await admin.get('/api/admin/users?pageSize=25');
  assert.equal(p1.status, 200);
  assert.equal(p1.data.items.length, 25);
  assert.equal(p1.data.total, 36);
  assert.equal(p1.data.pages, 2);
  const p2 = await admin.get(`/api/admin/users?pageSize=25&cursor=${p1.data.nextCursor}`);
  assert.equal(p2.data.page, 2);
  assert.equal(p2.data.items.length, 11);
  assert.equal(p2.data.from, 26);
  const ids = new Set([...p1.data.items, ...p2.data.items].map((u) => u.id));
  assert.equal(ids.size, 36, 'no duplicates across pages');
  const back = await admin.get(`/api/admin/users?pageSize=25&cursor=${p2.data.prevCursor}`);
  assert.deepEqual(back.data.items.map((u) => u.id), p1.data.items.map((u) => u.id));
  const filtered = await admin.get('/api/admin/users?q=bulk1');
  assert.ok(filtered.data.items.every((u) => u.username.startsWith('bulk1')));
});

test('conversation metadata vs contents: evidence access, elevation and reason required', async () => {
  const meta = await moderator.get(`/api/admin/conversations/${dmId}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.conversation.messageCount, 2);
  assert.equal(meta.data.canReadContent, false);
  assert.equal((await moderator.get(`/api/admin/conversations/${dmId}/messages?reason=testing`)).status, 403);

  const notElevated = await admin.get(`/api/admin/conversations/${dmId}/messages?reason=testing`);
  assert.equal(notElevated.data.error.code, 'reauth_required');
  assert.equal((await elevate(admin, adminSecret)).status, 200);
  const noReason = await admin.get(`/api/admin/conversations/${dmId}/messages`);
  assert.equal(noReason.status, 400);
  const ok = await admin.get(`/api/admin/conversations/${dmId}/messages?reason=${encodeURIComponent('Report #123 investigation')}&pageSize=25`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.total, 2);
  const byFile = await admin.get(`/api/admin/conversations/${dmId}/messages?reason=investigation&filename=project`);
  assert.equal(byFile.data.items.length, 1);
  const logged = srv.ctx.db.get("SELECT * FROM audit_log WHERE action = 'conversation.viewed' AND target_id = ? ORDER BY seq LIMIT 1", dmId);
  assert.equal(logged.reason, 'Report #123 investigation');
  assert.equal(logged.actor_id, admin.user.id);
});

test('file inspector: stats, password reveal audited, moderation', async () => {
  const detail = await admin.get(`/api/admin/files/${fileId}`);
  assert.equal(detail.data.file.passwordProtected, true);
  assert.equal(detail.data.file.originMessageId, msgId);
  assert.equal(detail.data.file.conversation.id, dmId);

  const revealNoReason = await admin.post(`/api/admin/files/${fileId}/reveal-password`, {});
  assert.equal(revealNoReason.status, 400);
  const reveal = await admin.post(`/api/admin/files/${fileId}/reveal-password`, { reason: 'Malware investigation' });
  assert.equal(reveal.data.filePassword, 'swordfish');
  assert.ok(srv.ctx.db.get("SELECT 1 FROM audit_log WHERE action = 'file.password_revealed' AND target_id = ?", fileId));

  const dl = await admin.get(`/api/admin/files/${fileId}/content?reason=evidence`, { raw: true });
  assert.equal(dl.status, 200);
  assert.ok(srv.ctx.db.get("SELECT 1 FROM audit_log WHERE action = 'file.downloaded' AND target_id = ?", fileId));

  const tabs = await admin.get('/api/admin/files?tab=largest');
  assert.equal(tabs.data.items[0].id, fileId);
  assert.equal((await moderator.post(`/api/admin/files/${fileId}/moderation`, { status: 'quarantined', reason: 'suspected malware' })).status, 200);
  assert.equal((await bob.get(`/api/files/${fileId}/content`)).status, 451);
});

test('moderation: warn/suspend by moderator, ban requires admin + elevation', async () => {
  assert.equal((await moderator.post(`/api/admin/users/${bob.user.id}/warn`, { reason: 'Be nice please' })).status, 200);
  assert.equal((await moderator.post(`/api/admin/users/${bob.user.id}/ban`, { reason: 'nope nope' })).status, 403);
  assert.equal((await moderator.post(`/api/admin/users/${admin.user.id}/suspend`, { reason: 'coup attempt', hours: 1 })).status, 403);
  assert.equal((await moderator.post(`/api/admin/users/${bob.user.id}/suspend`, { reason: 'cool off period', hours: 1 })).status, 200);
  assert.equal((await bob.get('/api/me')).status, 401, 'suspension revokes sessions');
  assert.equal((await admin.post(`/api/admin/users/${bob.user.id}/ban`, { reason: 'repeat offender' })).status, 200);
  assert.equal(srv.ctx.db.get('SELECT state FROM users WHERE id = ?', bob.user.id).state, 'banned');
});

test('staff permission changes are super-admin only and audited', async () => {
  assert.equal((await admin.patch(`/api/admin/users/${alice.user.id}/staff`, { role: 'site_moderator', reason: 'hiring' })).status, 403);
  await elevate(superAdmin, superSecret);
  assert.equal((await superAdmin.patch(`/api/admin/users/${alice.user.id}/staff`, { role: 'site_moderator', reason: 'hiring Alice' })).status, 200);
  assert.equal((await superAdmin.patch(`/api/admin/users/${superAdmin.user.id}/staff`, { role: 'user', reason: 'oops' })).status, 403);
  assert.equal((await superAdmin.patch(`/api/admin/users/${alice.user.id}/staff`, { evidenceAccess: true, reason: 'x' + 'yz12' })).status, 400, 'evidence access needs admin role');
});

test('audit log is append-only and hash-chained', async () => {
  const list = await superAdmin.get('/api/admin/audit?pageSize=25');
  assert.ok(list.data.total >= 5);
  assert.throws(() => srv.ctx.db.run("UPDATE audit_log SET reason = 'tampered'"), /append-only/);
  assert.throws(() => srv.ctx.db.run('DELETE FROM audit_log'), /append-only/);
  const v = await superAdmin.post('/api/admin/audit/verify');
  assert.equal(v.data.ok, true);
  assert.equal((await moderator.get('/api/admin/audit')).status, 403);
  const filtered = await superAdmin.get('/api/admin/audit?action=file.');
  assert.ok(filtered.data.items.every((a) => a.action.startsWith('file.')));
});

test('global search finds users, conversations, messages and files by id/name/hash', async () => {
  const hash = srv.ctx.db.get('SELECT sha256 FROM files WHERE id = ?', fileId).sha256;
  const byHash = await admin.get(`/api/admin/search?q=${hash}`);
  assert.ok(byHash.data.results.some((r) => r.type === 'file' && r.id === fileId));
  const byMsg = await admin.get(`/api/admin/search?q=${msgId}`);
  assert.equal(byMsg.data.results[0].path, `/admin/conversations/${dmId}?messageId=${msgId}`);
  const byUser = await admin.get('/api/admin/search?q=alice');
  assert.ok(byUser.data.results.some((r) => r.type === 'user'));
  const acct = srv.ctx.db.get('SELECT account_id FROM users WHERE id = ?', alice.user.id).account_id;
  const byAcct = await admin.get(`/api/admin/search?q=${acct.replace(/(\d{4})/g, '$1 ')}`);
  assert.ok(byAcct.data.results.some((r) => r.id === alice.user.id));
});

test('analytics dashboards respond for every section and range', async () => {
  const comms = await admin.get('/api/admin/communications?range=24h');
  assert.equal(comms.status, 200);
  assert.equal(comms.data.kpis.activeDms, 1);
  assert.ok(comms.data.rankings.conversations[0].name.startsWith('DM '), 'DM rankings do not reveal participants');
  for (const section of ['users', 'messaging', 'groups', 'spaces', 'storage', 'bandwidth', 'engagement', 'revenue', 'moderation', 'security']) {
    const r = await admin.get(`/api/admin/analytics?section=${section}&range=7d`);
    assert.equal(r.status, 200, section);
  }
  const custom = await admin.get('/api/admin/analytics?section=messaging&range=custom&from=2020-01-01&to=2020-01-31');
  assert.equal(custom.status, 200);
  for (const type of ['files', 'groups', 'spaces', 'channels']) assert.equal((await admin.get(`/api/admin/trending?type=${type}`)).status, 200);
  const storage = await admin.get('/api/admin/storage');
  assert.ok(storage.data.forecast.currentBytes > 0);
  assert.equal((await moderator.get('/api/admin/analytics?section=users')).status, 403);
});
