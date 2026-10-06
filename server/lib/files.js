import fs from 'node:fs';
import { conversationAccess } from './perms.js';
import { HttpError, forbidden, notFound } from './http.js';
import { INLINE_SAFE } from './filetype.js';
import { newId, randomToken, sha256 } from './crypto.js';
import { config } from '../config.js';

/** Files used as profile/space/group images are visible to any signed-in user. */
function isPublicImage(db, fileId) {
  return !!(
    db.get('SELECT 1 FROM users WHERE avatar_file_id = ? OR banner_file_id = ? LIMIT 1', fileId, fileId) ||
    db.get('SELECT 1 FROM spaces WHERE (icon_file_id = ? OR banner_file_id = ?) AND removed_at IS NULL LIMIT 1', fileId, fileId) ||
    db.get('SELECT 1 FROM conversations WHERE avatar_file_id = ? AND removed_at IS NULL LIMIT 1', fileId)
  );
}

/**
 * Can `userId` read this stored file through the product (not via admin tools)?
 * Returns { ok, via } where via is 'owner' | 'conversation' | 'public_image'.
 */
export function fileAccess(db, userId, file) {
  if (!file) return { ok: false };
  if (file.moderation_status === 'removed' || file.moderation_status === 'quarantined') return { ok: false, blocked: true };
  if (file.owner_id === userId && !file.purged_at) return { ok: true, via: 'owner' };
  // Files sent in conversations stay readable there even if the owner later deletes them from My Files.
  const uses = db.all(
    `SELECT m.conversation_id, m.created_at FROM message_attachments a JOIN messages m ON m.id = a.message_id
     WHERE a.file_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 25`,
    file.id,
  );
  for (const u of uses) {
    const a = conversationAccess(db, userId, u.conversation_id, { allowMissing: true });
    // Members, and people previewing a public group/Space channel, can open what they can see.
    if ((a?.can.view || a?.preview) && !(a.member?.cleared_at && u.created_at <= a.member.cleared_at)) return { ok: true, via: 'conversation' };
  }
  if (!file.purged_at && file.category === 'image' && isPublicImage(db, file.id)) return { ok: true, via: 'public_image' };
  return { ok: false };
}

export function issueTicket(db, { fileId, userId = null, linkId = null }) {
  const token = randomToken(24);
  db.run('DELETE FROM download_tickets WHERE expires_at < ?', Date.now());
  db.run('INSERT INTO download_tickets (token_hash, file_id, user_id, link_id, expires_at) VALUES (?,?,?,?,?)',
    sha256(token), fileId, userId, linkId, Date.now() + 10 * 60_000);
  return token;
}

export function checkTicket(db, token, { fileId, userId = null, linkId = null }) {
  if (!token) return false;
  const t = db.get('SELECT * FROM download_tickets WHERE token_hash = ?', sha256(String(token)));
  if (!t || t.expires_at < Date.now() || t.file_id !== fileId) return false;
  if (linkId && t.link_id !== linkId) return false;
  if (!linkId && t.user_id !== userId) return false;
  return true;
}

function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams a decrypted file. Only allowlisted media types are served inline; all else
 * is forced to download. A sandbox CSP stops any served content from running script.
 */
export function streamFile(ctx, req, res, file, { download = false, eventType, userId = null, onComplete, track = true } = {}) {
  const blob = ctx.db.get('SELECT * FROM blobs WHERE id = ?', file.blob_id);
  if (!blob || blob.deleted_at || !fs.existsSync(ctx.blobs.pathFor(blob.id))) throw notFound('File content');
  const inline = !download && INLINE_SAFE.has(file.mime);
  res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.filename));
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.method === 'HEAD') return res.end();
  const type = eventType || (inline ? 'view' : 'download');
  const stream = ctx.blobs.read(blob);
  let sent = 0;
  stream.on('data', (c) => (sent += c.length));
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500);
    res.destroy(err);
  });
  stream.on('end', () => {
    if (!track) return;
    const t = Date.now();
    ctx.db.run('INSERT INTO file_events (file_id, blob_id, type, user_id, bytes, created_at) VALUES (?,?,?,?,?,?)', file.id, file.blob_id, type, userId, sent, t);
    const counter = type === 'view' ? 'view_count' : 'download_count';
    ctx.db.run(`UPDATE files SET ${counter} = ${counter} + 1, bandwidth_bytes = bandwidth_bytes + ? WHERE id = ?`, sent, file.id);
    onComplete?.(sent);
  });
  stream.pipe(res);
}

/** Permanently removes a file from My Files. The blob is deleted once nothing references it. */
export function purgeFile(ctx, file) {
  const { db } = ctx;
  db.tx(() => {
    db.run('UPDATE files SET purged_at = ?, trashed_at = COALESCE(trashed_at, ?) WHERE id = ? AND purged_at IS NULL', Date.now(), Date.now(), file.id);
    db.run('UPDATE file_links SET revoked_at = COALESCE(revoked_at, ?) WHERE file_id = ?', Date.now(), file.id);
    db.run('UPDATE blobs SET ref_count = MAX(0, ref_count - 1) WHERE id = ?', file.blob_id);
  });
  collectBlob(ctx, file.blob_id);
}

/** Deletes a stored object when no live file and no live message attachment refers to it. */
export function collectBlob(ctx, blobId) {
  const { db } = ctx;
  const live = db.get(
    `SELECT 1 FROM files f WHERE f.blob_id = ? AND (f.purged_at IS NULL OR EXISTS (
       SELECT 1 FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE a.file_id = f.id AND m.deleted_at IS NULL))
     LIMIT 1`, blobId,
  );
  if (live) return false;
  // The row is kept (file records reference it) but the stored bytes are destroyed.
  db.run('UPDATE blobs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), blobId);
  ctx.blobs.remove(blobId);
  return true;
}

export function collectOrphanBlobs(ctx) {
  let removed = 0;
  const rows = ctx.db.all(
    `SELECT b.id FROM blobs b WHERE b.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id AND f.purged_at IS NULL) LIMIT 1000`,
  );
  for (const r of rows) if (collectBlob(ctx, r.id)) removed++;
  return removed;
}

/** Purges trashed files past their plan's retention window. */
export function purgeExpiredTrash(ctx) {
  const { db } = ctx;
  let purged = 0;
  for (const [plan, limits] of Object.entries(config.plans)) {
    const cutoff = Date.now() - limits.trashRetentionDays * 86400_000;
    const rows = db.all(
      `SELECT f.* FROM files f JOIN users u ON u.id = f.owner_id
       WHERE f.trashed_at IS NOT NULL AND f.trashed_at < ? AND f.purged_at IS NULL AND u.plan = ? LIMIT 1000`, cutoff, plan,
    );
    for (const f of rows) {
      purgeFile(ctx, f);
      purged++;
    }
  }
  return purged;
}

/** Creates a user's file record pointing at an existing blob (no copy). */
export function createFileRecord(db, { ownerId, blob, filename, mime, category, size, sha256: hash }) {
  const id = newId('fil');
  db.tx(() => {
    db.run(
      `INSERT INTO files (id, owner_id, blob_id, filename, mime, category, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, ownerId, blob.id, filename, mime, category, size, hash, Date.now(),
    );
    db.run('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?', blob.id);
  });
  return db.get('SELECT * FROM files WHERE id = ?', id);
}

export function requireFileAccess(db, user, id) {
  const file = db.get('SELECT * FROM files WHERE id = ?', id);
  const acc = fileAccess(db, user.id, file);
  if (!acc.ok) {
    if (acc.blocked) throw new HttpError(451, 'file_unavailable', 'This file was removed for violating the rules.');
    throw notFound('File');
  }
  return { file, via: acc.via };
}

export const requireOwner = (file, user) => {
  if (file.owner_id !== user.id) throw forbidden('Only the owner can do that.');
};
