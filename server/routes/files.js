import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { h, str, bad, notFound, HttpError, oneOf, bool } from '../lib/http.js';
import { requireUser, notRestricted } from '../lib/auth.js';
import { detectFileType } from '../lib/filetype.js';
import { makeVerifier, checkVerifier, seal } from '../lib/crypto.js';
import {
  requireFileAccess, streamFile, purgeFile, issueTicket, checkTicket, createFileRecord,
} from '../lib/files.js';
import { fileSummary } from '../lib/messaging.js';
import { usageFor, planOf } from './me.js';
import { config } from '../config.js';

const CATEGORY_FILTERS = {
  recent: "f.trashed_at IS NULL",
  images: "f.trashed_at IS NULL AND f.category = 'image'",
  videos: "f.trashed_at IS NULL AND f.category = 'video'",
  audio: "f.trashed_at IS NULL AND f.category = 'audio'",
  documents: "f.trashed_at IS NULL AND f.category = 'document'",
  archives: "f.trashed_at IS NULL AND f.category = 'archive'",
  other: "f.trashed_at IS NULL AND f.category = 'other'",
  trash: 'f.trashed_at IS NOT NULL',
};

export function cleanFilename(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex -- stripping control characters is intentional
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return cleaned || 'file';
}

export default function fileRoutes(ctx) {
  const r = Router();
  const { db, blobs, limiter } = ctx;
  r.use(requireUser);

  const upload = multer({
    dest: blobs.tmpDir(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 },
  });

  const ownedFile = (req) => {
    const f = db.get('SELECT * FROM files WHERE id = ? AND purged_at IS NULL', req.params.id);
    if (!f || f.owner_id !== req.user.id) throw notFound('File');
    return f;
  };

  function fileView(f, viewerId) {
    const out = fileSummary(f);
    if (f.owner_id === viewerId) {
      Object.assign(out, {
        trashedAt: f.trashed_at,
        downloads: f.download_count,
        shares: f.share_count,
        activeLinks: Number(db.value('SELECT COUNT(*) FROM file_links WHERE file_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', f.id, Date.now())),
      });
    }
    return out;
  }

  /** Upload once; the stored object is deduplicated by content hash and encrypted at rest. */
  r.post('/', (req, res, next) => {
    try {
      notRestricted(req);
      limiter.check(`upload:${req.user.id}`, config.isTest ? 1000 : 60, 10 * 60_000);
    } catch (err) {
      return next(err);
    }
    upload.single('file')(req, res, (err) => (err ? next(err) : next()));
  }, h(async (req, res) => {
    const tmp = req.file?.path;
    if (!req.file) throw bad('No file was uploaded.');
    try {
      const plan = planOf(req.user);
      if (req.file.size > plan.uploadBytes) {
        throw new HttpError(413, 'too_large', `Your plan allows uploads up to ${Math.round(plan.uploadBytes / 1024 / 1024)} MB.`);
      }
      if (req.file.size === 0) throw bad('The file is empty.');
      const used = usageFor(db, req.user.id).storageBytes;
      if (used + req.file.size > plan.storageBytes) {
        throw new HttpError(413, 'quota_exceeded', 'Not enough storage left. Empty your trash or upgrade to Plus.');
      }
      const filename = cleanFilename(req.body.filename || req.file.originalname);
      const info = await blobs.inspect(tmp);
      const type = detectFileType(info.head, filename);
      if (type.error) throw bad(type.error, 'type_mismatch');

      let blob = db.get('SELECT * FROM blobs WHERE sha256 = ? AND deleted_at IS NULL', info.sha256);
      if (!blob) {
        const stored = await blobs.put(tmp);
        // Another upload of the same content may have finished while we were encrypting.
        blob = db.get('SELECT * FROM blobs WHERE sha256 = ? AND deleted_at IS NULL', info.sha256);
        if (blob) {
          blobs.remove(stored.id);
        } else {
          db.run('INSERT INTO blobs (id, sha256, size, mime, auth_tag, iv, ref_count, created_at) VALUES (?,?,?,?,?,?,0,?)',
            stored.id, info.sha256, info.size, type.mime, stored.authTag, stored.iv, Date.now());
          blob = db.get('SELECT * FROM blobs WHERE id = ?', stored.id);
        }
      }
      const file = createFileRecord(db, {
        ownerId: req.user.id, blob, filename, mime: type.mime, category: type.category, size: info.size, sha256: info.sha256,
      });
      db.run('INSERT INTO file_events (file_id, blob_id, type, user_id, bytes, created_at) VALUES (?,?,?,?,?,?)', file.id, blob.id, 'upload', req.user.id, info.size, Date.now());
      res.status(201).json({ file: fileView(file, req.user.id), deduplicated: blob.ref_count > 1 });
    } finally {
      if (tmp) fs.rm(tmp, { force: true }, () => {});
    }
  }));

  r.get('/', h((req, res) => {
    const category = oneOf(req.query.category, 'category', Object.keys(CATEGORY_FILTERS), 'recent');
    const where = [`f.owner_id = ?`, 'f.purged_at IS NULL', CATEGORY_FILTERS[category]];
    const params = [req.user.id];
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push("f.filename LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }
    const sortCol = category === 'trash' ? 'f.trashed_at' : 'f.created_at';
    if (req.query.before) {
      const [t, id] = String(req.query.before).split('~');
      where.push(`(${sortCol} < ? OR (${sortCol} = ? AND f.id < ?))`);
      params.push(Number(t), Number(t), id || '');
    }
    const rows = db.all(`SELECT f.* FROM files f WHERE ${where.join(' AND ')} ORDER BY ${sortCol} DESC, f.id DESC LIMIT 60`, ...params);
    const last = rows[rows.length - 1];
    res.json({
      files: rows.map((f) => fileView(f, req.user.id)),
      nextCursor: rows.length === 60 ? `${category === 'trash' ? last.trashed_at : last.created_at}~${last.id}` : null,
      usage: usageFor(db, req.user.id),
      plan: planOf(req.user),
    });
  }));

  r.post('/trash/empty', h((req, res) => {
    const rows = db.all('SELECT * FROM files WHERE owner_id = ? AND trashed_at IS NOT NULL AND purged_at IS NULL', req.user.id);
    for (const f of rows) purgeFile(ctx, f);
    res.json({ purged: rows.length });
  }));

  r.get('/:id', h((req, res) => {
    const { file } = requireFileAccess(db, req.user, req.params.id);
    res.json({ file: fileView(file, req.user.id) });
  }));

  r.patch('/:id', h((req, res) => {
    const f = ownedFile(req);
    if (req.body.filename !== undefined) {
      const filename = cleanFilename(str(req.body.filename, 'Filename', { min: 1, max: 200 }));
      const ext = (n) => (/\.([a-z0-9]{1,10})$/i.exec(n)?.[1] || '').toLowerCase();
      if (ext(filename) !== ext(f.filename)) throw bad('Renaming cannot change the file extension.');
      db.run('UPDATE files SET filename = ? WHERE id = ?', filename, f.id);
    }
    res.json({ file: fileView(db.get('SELECT * FROM files WHERE id = ?', f.id), req.user.id) });
  }));

  r.delete('/:id', h((req, res) => {
    const f = ownedFile(req);
    if (bool(req.query.permanent)) {
      purgeFile(ctx, f);
    } else {
      db.run('UPDATE files SET trashed_at = ? WHERE id = ?', Date.now(), f.id);
      db.run('UPDATE file_links SET revoked_at = COALESCE(revoked_at, ?) WHERE file_id = ?', Date.now(), f.id);
    }
    res.json({ ok: true });
  }));

  r.post('/:id/restore', h((req, res) => {
    const f = ownedFile(req);
    db.run('UPDATE files SET trashed_at = NULL WHERE id = ?', f.id);
    res.json({ file: fileView(db.get('SELECT * FROM files WHERE id = ?', f.id), req.user.id) });
  }));

  /**
   * Password protection. The verifier (scrypt) is used for access checks. A recoverable
   * copy is sealed with a dedicated key kept outside the database, so only authorized
   * evidence-access staff can reveal it (and each reveal is audited).
   */
  r.put('/:id/password', h((req, res) => {
    limiter.check(`filepw:${req.user.id}`, 30, 60_000);
    const f = ownedFile(req);
    const password = str(req.body.password, 'Password', { min: 4, max: 128, trim: false });
    db.run('UPDATE files SET password_verifier = ?, password_sealed = ? WHERE id = ?',
      makeVerifier(password), seal('filePassword', password, `file:${f.id}`), f.id);
    res.json({ ok: true });
  }));

  r.delete('/:id/password', h((req, res) => {
    const f = ownedFile(req);
    db.run('UPDATE files SET password_verifier = NULL, password_sealed = NULL WHERE id = ?', f.id);
    res.json({ ok: true });
  }));

  /** Exchanges a file password for a short-lived download ticket. */
  r.post('/:id/unlock', h((req, res) => {
    const { file } = requireFileAccess(db, req.user, req.params.id);
    limiter.check(`unlock:${req.user.id}:${file.id}`, 10, 15 * 60_000);
    if (file.password_verifier && file.owner_id !== req.user.id && !checkVerifier(String(req.body.password || ''), file.password_verifier)) {
      throw new HttpError(401, 'wrong_password', 'Incorrect password.');
    }
    res.json({ ticket: issueTicket(db, { fileId: file.id, userId: req.user.id }) });
  }));

  r.get('/:id/content', h((req, res) => {
    const { file } = requireFileAccess(db, req.user, req.params.id);
    if (file.password_verifier && file.owner_id !== req.user.id &&
        !checkTicket(db, req.query.ticket, { fileId: file.id, userId: req.user.id })) {
      throw new HttpError(401, 'password_required', 'This file is password protected.');
    }
    streamFile(ctx, req, res, file, { download: bool(req.query.download), userId: req.user.id });
  }));

  /** "Save to My Files": adds a reference to the same stored object — no copy is made. */
  r.post('/:id/save', h((req, res) => {
    notRestricted(req);
    const { file } = requireFileAccess(db, req.user, req.params.id);
    if (file.owner_id === req.user.id && !file.purged_at) return res.json({ file: fileView(file, req.user.id), alreadyOwned: true });
    if (file.password_verifier && !checkTicket(db, req.body.ticket, { fileId: file.id, userId: req.user.id })) {
      throw new HttpError(401, 'password_required', 'Unlock this file first.');
    }
    if (file.moderation_status !== 'ok') throw bad('This file cannot be saved.');
    const existing = db.get('SELECT * FROM files WHERE owner_id = ? AND sha256 = ? AND purged_at IS NULL AND trashed_at IS NULL', req.user.id, file.sha256);
    if (existing) return res.json({ file: fileView(existing, req.user.id), alreadyOwned: true });
    const plan = planOf(req.user);
    if (usageFor(db, req.user.id).storageBytes + file.size > plan.storageBytes) {
      throw new HttpError(413, 'quota_exceeded', 'Not enough storage left.');
    }
    const blob = db.get('SELECT * FROM blobs WHERE id = ? AND deleted_at IS NULL', file.blob_id);
    if (!blob) throw notFound('File content');
    const copy = createFileRecord(db, {
      ownerId: req.user.id, blob, filename: file.filename, mime: file.mime, category: file.category, size: file.size, sha256: file.sha256,
    });
    res.status(201).json({ file: fileView(copy, req.user.id) });
  }));

  return r;
}

