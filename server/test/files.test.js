import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, PNG, ZIP, EXE } from './helpers.js';

let srv, alice, bob, carol;
before(async () => {
  srv = await startServer();
  alice = srv.client();
  bob = srv.client();
  carol = srv.client();
  await alice.register('Alice', 'alice');
  await bob.register('Bob', 'bob');
  await carol.register('Carol', 'carol');
});
after(async () => srv.stop());

test('upload validates signatures and deduplicates stored objects', async () => {
  const a = await alice.upload('photo.png', PNG);
  assert.equal(a.status, 201);
  assert.equal(a.data.file.category, 'image');
  assert.equal(a.data.file.mime, 'image/png');
  const b = await bob.upload('same.png', PNG);
  assert.equal(b.status, 201);
  assert.equal(srv.ctx.db.value('SELECT COUNT(*) FROM blobs'), 1, 'identical content is stored once');
  assert.equal(srv.ctx.db.value('SELECT COUNT(*) FROM files'), 2);

  const spoof = await alice.upload('cute.jpg', EXE);
  assert.equal(spoof.status, 400);
  assert.equal(spoof.data.error.code, 'type_mismatch');
  const zip = await alice.upload('Project.zip', ZIP);
  assert.equal(zip.data.file.category, 'archive');

  // Stored at rest encrypted: the plaintext PNG signature must not appear on disk.
  const blob = srv.ctx.db.get('SELECT * FROM blobs LIMIT 1');
  const onDisk = fs.readFileSync(srv.ctx.blobs.pathFor(blob.id));
  assert.ok(!onDisk.subarray(0, 8).equals(PNG.subarray(0, 8)));
});

test('send an existing stored file into a conversation without copying it', async () => {
  const up = await alice.upload('Project.zip', Buffer.concat([ZIP, Buffer.from('v2')]));
  const fileId = up.data.file.id;
  const dm = await alice.post('/api/conversations/dm', { userId: bob.user.id });
  const send = await alice.post(`/api/conversations/${dm.data.conversation.id}/messages`, { fileIds: [fileId] });
  assert.equal(send.status, 201);
  assert.equal(send.data.message.kind, 'file');
  assert.equal(send.data.message.attachments[0].id, fileId);
  const blobs = srv.ctx.db.value('SELECT COUNT(*) FROM blobs');

  // Bob can download it through the conversation; Carol cannot.
  const dl = await bob.get(`/api/files/${fileId}/content?download=1`, { raw: true });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(Buffer.from(await dl.arrayBuffer()).length, ZIP.length + 2);
  assert.equal((await carol.get(`/api/files/${fileId}/content`)).status, 404);

  // Bob saves it to his files — a new reference to the same blob.
  const saved = await bob.post(`/api/files/${fileId}/save`);
  assert.equal(saved.status, 201);
  assert.equal(srv.ctx.db.value('SELECT COUNT(*) FROM blobs'), blobs);
  const mine = await bob.get('/api/files?category=archives');
  assert.ok(mine.data.files.some((f) => f.id === saved.data.file.id));

  // Only the owner's files can be attached.
  const steal = await carol.post(`/api/conversations/${dm.data.conversation.id}/messages`, { fileIds: [fileId] });
  assert.equal(steal.status, 404);
});

test('password-protected files need unlocking and store only encrypted recoverable passwords', async () => {
  const up = await alice.upload('secret.zip', Buffer.concat([ZIP, Buffer.from('secret')]));
  const id = up.data.file.id;
  assert.equal((await alice.put(`/api/files/${id}/password`, { password: 'hunter22' })).status, 200);
  const row = srv.ctx.db.get('SELECT * FROM files WHERE id = ?', id);
  assert.ok(!JSON.stringify(row).includes('hunter22'));
  assert.match(row.password_sealed, /^v1\./);

  const dm = await alice.post('/api/conversations/dm', { userId: bob.user.id });
  await alice.post(`/api/conversations/${dm.data.conversation.id}/messages`, { fileIds: [id] });
  assert.equal((await bob.get(`/api/files/${id}/content`)).status, 401);
  assert.equal((await bob.post(`/api/files/${id}/unlock`, { password: 'wrong' })).status, 401);
  const unlock = await bob.post(`/api/files/${id}/unlock`, { password: 'hunter22' });
  assert.equal(unlock.status, 200);
  const dl = await bob.get(`/api/files/${id}/content?ticket=${unlock.data.ticket}`, { raw: true });
  assert.equal(dl.status, 200);
});

test('share links: password, max downloads, audience, revoke, Files → Shared', async () => {
  const up = await alice.upload('game-build.zip', Buffer.concat([ZIP, Buffer.from('build')]));
  const id = up.data.file.id;
  const link = await alice.post(`/api/files/${id}/links`, { audience: 'anyone', password: 'letmein', maxDownloads: 1 });
  assert.equal(link.status, 201);
  const token = link.data.link.token;

  const anon = srv.client();
  const meta = await anon.get(`/api/public/links/${token}`);
  assert.equal(meta.data.passwordProtected, true);
  assert.equal(meta.data.file.filename, 'game-build.zip');
  assert.equal((await anon.post(`/api/public/links/${token}/unlock`, { password: 'nope' })).status, 401);
  const t = await anon.post(`/api/public/links/${token}/unlock`, { password: 'letmein' });
  const d1 = await anon.get(`/api/public/links/${token}/content?ticket=${t.data.ticket}&download=1`, { raw: true });
  assert.equal(d1.status, 200);
  await d1.arrayBuffer();
  const d2 = await anon.get(`/api/public/links/${token}/content?ticket=${t.data.ticket}&download=1`);
  assert.equal(d2.status, 410);

  const sel = await alice.post(`/api/files/${id}/links`, { audience: 'selected', selectedUsers: ['bob'] });
  const selToken = sel.data.link.token;
  assert.equal((await anon.get(`/api/public/links/${selToken}`)).data.requiresLogin, true);
  assert.equal((await carol.get(`/api/public/links/${selToken}`)).status, 403);
  assert.equal((await bob.get(`/api/public/links/${selToken}`)).status, 200);

  const shared = await alice.get('/api/links');
  assert.equal(shared.data.links.length, 2);
  assert.equal(shared.data.links.find((l) => l.token === token).status, 'limit_reached');
  assert.equal((await alice.del(`/api/links/${sel.data.link.id}`)).status, 200);
  assert.equal((await bob.get(`/api/public/links/${selToken}`)).status, 410);

  const f = srv.ctx.db.get('SELECT * FROM files WHERE id = ?', id);
  assert.equal(f.download_count, 1);
  assert.ok(f.bandwidth_bytes > 0);
});

test('trash, restore and permanent delete', async () => {
  const up = await alice.upload('notes.txt', Buffer.from('hello notes'));
  assert.equal(up.data.file.category, 'document');
  const id = up.data.file.id;
  await alice.del(`/api/files/${id}`);
  assert.ok((await alice.get('/api/files?category=trash')).data.files.some((f) => f.id === id));
  await alice.post(`/api/files/${id}/restore`);
  assert.ok((await alice.get('/api/files?category=documents')).data.files.some((f) => f.id === id));
  const blobId = srv.ctx.db.get('SELECT blob_id FROM files WHERE id = ?', id).blob_id;
  await alice.del(`/api/files/${id}?permanent=1`);
  assert.ok(srv.ctx.db.get('SELECT * FROM blobs WHERE id = ?', blobId).deleted_at, 'unreferenced blob is deleted');
  assert.ok(!fs.existsSync(srv.ctx.blobs.pathFor(blobId)));
});
