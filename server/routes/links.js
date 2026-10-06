import { Router } from 'express';
import { h, str, bad, notFound, forbidden, HttpError, oneOf, int, bool } from '../lib/http.js';
import { requireUser, notRestricted } from '../lib/auth.js';
import { randomToken, newId, makeVerifier, checkVerifier, seal } from '../lib/crypto.js';
import { streamFile, issueTicket, checkTicket } from '../lib/files.js';
import { fileSummary } from '../lib/messaging.js';
import { isContact, miniUser } from '../lib/users.js';
import { planOf, usageFor } from './me.js';
import { config } from '../config.js';

export function linkStatus(l, file) {
  if (l.revoked_at) return 'revoked';
  if (file && (file.trashed_at || file.purged_at || !['ok'].includes(file.moderation_status))) return 'unavailable';
  if (l.expires_at && l.expires_at <= Date.now()) return 'expired';
  if (l.max_downloads && l.downloads >= l.max_downloads) return 'limit_reached';
  return 'active';
}

function linkView(l, file) {
  return {
    id: l.id,
    url: `${config.publicOrigin}/s/${l.token}`,
    token: l.token,
    file: fileSummary(file),
    audience: l.audience,
    selectedUsers: JSON.parse(l.selected_users || '[]'),
    passwordProtected: !!l.password_verifier,
    expiresAt: l.expires_at,
    maxDownloads: l.max_downloads,
    downloads: l.downloads,
    allowDownload: !!l.allow_download,
    createdAt: l.created_at,
    revokedAt: l.revoked_at,
    status: linkStatus(l, file),
  };
}

export default function linkRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;

  // ---- Owner management ------------------------------------------------------------

  r.post('/files/:id/links', requireUser, h((req, res) => {
    notRestricted(req);
    limiter.check(`mklink:${req.user.id}`, 30, 60_000);
    const file = db.get('SELECT * FROM files WHERE id = ? AND owner_id = ? AND purged_at IS NULL AND trashed_at IS NULL', req.params.id, req.user.id);
    if (!file) throw notFound('File');
    if (file.moderation_status !== 'ok') throw forbidden('Sharing is restricted for this file.');
    const plan = planOf(req.user);
    if (usageFor(db, req.user.id).activeLinks >= plan.activeLinks) {
      throw new HttpError(402, 'plan_limit', `Your plan allows ${plan.activeLinks} active links. Revoke some or upgrade to Plus.`);
    }
    const b = req.body || {};
    const audience = oneOf(b.audience, 'Audience', ['anyone', 'selected', 'contacts'], 'anyone');
    let selected = [];
    if (audience === 'selected') {
      const raw = Array.isArray(b.selectedUsers) ? b.selectedUsers.slice(0, 50) : [];
      selected = raw.map((idOrName) => {
        const u = db.get('SELECT id, username, display_name FROM users WHERE id = ? OR username = ?', String(idOrName), String(idOrName).replace(/^@/, ''));
        if (!u) throw bad(`User "${idOrName}" not found.`);
        return u.id;
      });
      if (!selected.length) throw bad('Choose at least one person.');
    }
    const password = b.password ? str(b.password, 'Password', { min: 4, max: 128, trim: false }) : null;
    let expiresAt = null;
    if (b.expiresInHours) expiresAt = Date.now() + int(b.expiresInHours, 'Expiry', { min: 1, max: 24 * 365 }) * 3600_000;
    else if (b.expiresAt) {
      expiresAt = Number(new Date(b.expiresAt));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw bad('Expiration must be in the future.');
    }
    const maxDownloads = b.maxDownloads ? int(b.maxDownloads, 'Max downloads', { min: 1, max: 1_000_000 }) : null;
    const id = newId('shl');
    db.run(
      `INSERT INTO file_links (id, token, file_id, created_by, audience, selected_users, password_verifier, password_sealed,
         expires_at, max_downloads, allow_download, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, randomToken(18), file.id, req.user.id, audience, JSON.stringify(selected),
      password ? makeVerifier(password) : null, password ? seal('filePassword', password, `link:${id}`) : null,
      expiresAt, maxDownloads, bool(b.allowDownload, true) ? 1 : 0, Date.now(),
    );
    db.run('UPDATE files SET share_count = share_count + 1 WHERE id = ?', file.id);
    db.run('INSERT INTO file_events (file_id, blob_id, type, user_id, created_at) VALUES (?,?,?,?,?)', file.id, file.blob_id, 'share', req.user.id, Date.now());
    res.status(201).json({ link: linkView(db.get('SELECT * FROM file_links WHERE id = ?', id), file) });
  }));

  /** Files → Shared: every link the user has created. */
  r.get('/links', requireUser, h((req, res) => {
    const rows = db.all(
      `SELECT l.*, f.id AS f_id FROM file_links l JOIN files f ON f.id = l.file_id WHERE l.created_by = ?
       ORDER BY l.revoked_at IS NOT NULL, l.created_at DESC LIMIT 500`, req.user.id,
    );
    const status = req.query.status;
    const links = rows
      .map((l) => linkView(l, db.get('SELECT * FROM files WHERE id = ?', l.file_id)))
      .filter((l) => !status || status === 'all' || (status === 'active' ? l.status === 'active' : l.status !== 'active'));
    res.json({ links });
  }));

  r.delete('/links/:id', requireUser, h((req, res) => {
    const l = db.get('SELECT * FROM file_links WHERE id = ? AND created_by = ?', req.params.id, req.user.id);
    if (!l) throw notFound('Link');
    db.run('UPDATE file_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), l.id);
    res.json({ ok: true });
  }));

  // ---- Public access ------------------------------------------------------------------

  function resolve(req) {
    limiter.check(`linkview:${req.ip}`, config.isTest ? 10_000 : 120, 60_000);
    const l = db.get('SELECT * FROM file_links WHERE token = ?', String(req.params.token));
    if (!l) throw notFound('Link');
    const file = db.get('SELECT * FROM files WHERE id = ?', l.file_id);
    const status = linkStatus(l, file);
    if (status !== 'active') {
      throw new HttpError(410, `link_${status}`, {
        revoked: 'This link was revoked.', expired: 'This link has expired.', limit_reached: 'This link reached its download limit.',
        unavailable: 'This file is no longer available.',
      }[status]);
    }
    // Audience checks: "selected" and "contacts" links require signing in.
    let allowed = true;
    let requiresLogin = false;
    if (l.audience !== 'anyone') {
      if (!req.user) {
        allowed = false;
        requiresLogin = true;
      } else if (req.user.id !== l.created_by) {
        allowed = l.audience === 'selected'
          ? JSON.parse(l.selected_users || '[]').includes(req.user.id)
          : isContact(db, l.created_by, req.user.id);
      }
    }
    const verifier = l.password_verifier || file.password_verifier;
    return { l, file, allowed, requiresLogin, verifier };
  }

  r.get('/public/links/:token', h((req, res) => {
    const { l, file, allowed, requiresLogin, verifier } = resolve(req);
    if (requiresLogin) return res.json({ requiresLogin: true });
    if (!allowed) throw forbidden('This link was shared with specific people.');
    res.json({
      file: { filename: file.filename, size: file.size, mime: file.mime, category: file.category },
      owner: miniUser(db.get('SELECT * FROM users WHERE id = ?', l.created_by)),
      passwordProtected: !!verifier,
      allowDownload: !!l.allow_download,
      expiresAt: l.expires_at,
      downloadsRemaining: l.max_downloads ? l.max_downloads - l.downloads : null,
    });
  }));

  r.post('/public/links/:token/unlock', h((req, res) => {
    const { l, file, allowed, requiresLogin, verifier } = resolve(req);
    if (requiresLogin) throw new HttpError(401, 'unauthenticated', 'Sign in to open this link.');
    if (!allowed) throw forbidden('This link was shared with specific people.');
    limiter.check(`linkpw:${req.ip}:${l.id}`, config.isTest ? 1000 : 10, 15 * 60_000);
    if (verifier && !checkVerifier(String(req.body.password || ''), verifier)) {
      throw new HttpError(401, 'wrong_password', 'Incorrect password.');
    }
    res.json({ ticket: issueTicket(db, { fileId: file.id, linkId: l.id }) });
  }));

  r.get('/public/links/:token/content', h((req, res) => {
    const { l, file, allowed } = resolve(req);
    if (!allowed) throw forbidden('This link was shared with specific people.');
    if (!checkTicket(db, req.query.ticket, { fileId: file.id, linkId: l.id })) throw new HttpError(401, 'ticket_required', 'Open the link page first.');
    const download = bool(req.query.download);
    if (download && !l.allow_download) throw forbidden('The owner disabled downloads for this link.');
    if (download) {
      // Reserve a download slot atomically so max-downloads cannot be exceeded by parallel requests.
      const ok = db.run('UPDATE file_links SET downloads = downloads + 1 WHERE id = ? AND (max_downloads IS NULL OR downloads < max_downloads)', l.id);
      if (!ok.changes) throw new HttpError(410, 'link_limit_reached', 'This link reached its download limit.');
    }
    streamFile(ctx, req, res, file, { download, eventType: download ? 'link_download' : 'view', userId: req.user?.id ?? null });
  }));

  return r;
}
