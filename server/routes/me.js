import { Router } from 'express';
import {
  checkVerifier, generateRecoveryKey, generateTotpSecret, makeVerifier, normalizeRecoveryKey, seal, open, verifyTotp,
  formatAccountId,
} from '../lib/crypto.js';
import { h, str, bad, forbidden, notFound, HttpError } from '../lib/http.js';
import { requireUser, checkUserTotp, revokeSession } from '../lib/auth.js';
import { selfView, privacyOf, PRIVACY_OPTIONS } from '../lib/users.js';
import { validateUsername } from './auth.js';
import { audit, securityEvent } from '../lib/audit.js';
import { config } from '../config.js';
import { siteRank } from '../lib/perms.js';

export function usageFor(db, userId) {
  const storage = Number(db.value('SELECT COALESCE(SUM(size),0) FROM files WHERE owner_id = ? AND purged_at IS NULL', userId));
  const activeLinks = Number(db.value(
    'SELECT COUNT(*) FROM file_links WHERE created_by = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    userId, Date.now(),
  ));
  return { storageBytes: storage, activeLinks };
}

export const planOf = (user) => config.plans[user.plan] || config.plans.free;

function sessionView(s, currentId) {
  return {
    id: s.id,
    deviceName: s.device_name,
    deviceType: s.device_type,
    ip: s.ip,
    createdAt: s.created_at,
    lastActiveAt: s.last_active_at,
    current: s.id === currentId,
  };
}

export default function meRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  r.get('/', h((req, res) => {
    res.json({
      user: selfView(ctx, req.user),
      session: { id: req.session.id, elevatedUntil: req.session.elevated_until || null },
      plan: { id: req.user.plan, ...planOf(req.user) },
      usage: usageFor(db, req.user.id),
      unread: {
        notifications: Number(db.value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id)),
      },
    });
  }));

  r.patch('/profile', h((req, res) => {
    const b = req.body || {};
    const u = req.user;
    const updates = {};
    if (b.displayName !== undefined) updates.display_name = str(b.displayName, 'Display name', { min: 1, max: 48 });
    if (b.username !== undefined) updates.username = validateUsername(db, b.username, u.id);
    if (b.bio !== undefined) updates.bio = str(b.bio, 'Bio', { max: 500 });
    if (b.statusText !== undefined) updates.status_text = str(b.statusText, 'Status', { max: 80 });
    if (b.statusEmoji !== undefined) updates.status_emoji = str(b.statusEmoji, 'Status emoji', { max: 16 });
    if (b.links !== undefined) {
      if (!Array.isArray(b.links) || b.links.length > 5) throw bad('Up to 5 links are allowed.');
      updates.links = JSON.stringify(b.links.map((l, i) => {
        const url = str(l?.url, `Link ${i + 1}`, { min: 1, max: 300 });
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw bad(`Link ${i + 1} is not a valid URL.`);
        }
        if (!['https:', 'http:'].includes(parsed.protocol)) throw bad('Links must start with http:// or https://');
        return { label: str(l?.label, 'Link label', { max: 40 }) || parsed.hostname, url: parsed.toString() };
      }));
    }
    for (const [key, col] of [['avatarFileId', 'avatar_file_id'], ['bannerFileId', 'banner_file_id']]) {
      if (b[key] === undefined) continue;
      if (b[key] === null) {
        updates[col] = null;
        continue;
      }
      const f = db.get('SELECT * FROM files WHERE id = ? AND owner_id = ? AND trashed_at IS NULL', b[key], u.id);
      if (!f || f.category !== 'image') throw bad('Profile images must be images from My Files.');
      if (f.mime === 'image/gif' && !planOf(u).animatedProfile) {
        throw new HttpError(402, 'plan_required', 'Animated avatars and banners are a Plus feature.');
      }
      if (f.moderation_status !== 'ok') throw bad('That image is not available.');
      updates[col] = f.id;
    }
    const cols = Object.keys(updates);
    if (cols.length) {
      db.run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(updates), u.id);
    }
    res.json({ user: selfView(ctx, db.get('SELECT * FROM users WHERE id = ?', u.id)) });
  }));

  r.patch('/privacy', h((req, res) => {
    const current = privacyOf(req.user);
    for (const [key, value] of Object.entries(req.body || {})) {
      const options = PRIVACY_OPTIONS[key];
      if (!options) throw bad(`Unknown privacy setting: ${key}`);
      if (!options.includes(value)) throw bad(`Invalid value for ${key}.`);
      current[key] = value;
    }
    db.run('UPDATE users SET privacy = ? WHERE id = ?', JSON.stringify(current), req.user.id);
    res.json({ privacy: current });
  }));

  // ---- Devices / sessions -------------------------------------------------------

  r.get('/sessions', h((req, res) => {
    const rows = db.all(
      'SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND last_active_at > ? ORDER BY last_active_at DESC',
      req.user.id, Date.now() - config.sessionTtlMs,
    );
    res.json({ sessions: rows.map((s) => sessionView(s, req.session.id)) });
  }));

  r.delete('/sessions/:id', h((req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!s) throw notFound('Session');
    revokeSession(ctx, s.id);
    securityEvent(db, 'session_revoked', { userId: req.user.id, req, detail: { sessionId: s.id } });
    res.json({ ok: true });
  }));

  r.post('/sessions/revoke-others', h((req, res) => {
    const others = db.all('SELECT id FROM sessions WHERE user_id = ? AND id != ? AND revoked_at IS NULL', req.user.id, req.session.id);
    for (const s of others) revokeSession(ctx, s.id);
    securityEvent(db, 'sessions_revoked_all', { userId: req.user.id, req, detail: { count: others.length } });
    res.json({ revoked: others.length });
  }));

  // ---- Recovery key ------------------------------------------------------------

  /**
   * Regenerates the Recovery Key and invalidates the previous one. To stop a
   * freshly stolen session from locking the owner out, the caller must prove
   * possession of the current key, or a 2FA code, or use a device signed in for 7+ days.
   */
  r.post('/recovery/regenerate', h((req, res) => {
    limiter.check(`regen:${req.user.id}`, 5, 60 * 60_000);
    const u = req.user;
    const byKey = req.body.currentRecoveryKey && checkVerifier(normalizeRecoveryKey(req.body.currentRecoveryKey), u.recovery_verifier);
    const byTotp = req.body.totpCode && checkUserTotp(ctx, u, req.body.totpCode);
    const trustedDevice = req.session.created_at < Date.now() - 7 * 24 * 3600_000;
    if (!byKey && !byTotp && !trustedDevice) {
      throw forbidden('Enter your current Recovery Key (or 2FA code) to generate a new one. Devices signed in for 7+ days can skip this.', 'confirmation_required');
    }
    const recoveryKey = generateRecoveryKey();
    db.run('UPDATE users SET recovery_verifier = ?, recovery_rotated_at = ? WHERE id = ?',
      makeVerifier(normalizeRecoveryKey(recoveryKey)), Date.now(), u.id);
    securityEvent(db, 'recovery_key_rotated', { userId: u.id, req });
    if (req.body.signOutOthers) {
      for (const s of db.all('SELECT id FROM sessions WHERE user_id = ? AND id != ? AND revoked_at IS NULL', u.id, req.session.id)) {
        revokeSession(ctx, s.id);
      }
    }
    res.json({ accountId: formatAccountId(u.account_id), recoveryKey });
  }));

  // ---- Two-factor (TOTP) ------------------------------------------------------------

  r.post('/2fa/setup', h((req, res) => {
    if (req.user.totp_enabled) throw bad('Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    db.run('UPDATE users SET totp_secret_sealed = ? WHERE id = ?', seal('app', secret, `totp:${req.user.id}`), req.user.id);
    const label = encodeURIComponent(`messgae:${req.user.username}`);
    res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=messgae&algorithm=SHA1&digits=6&period=30` });
  }));

  r.post('/2fa/enable', h((req, res) => {
    limiter.check(`2fa:${req.user.id}`, 10, 15 * 60_000);
    const u = req.user;
    if (u.totp_enabled) throw bad('Already enabled.');
    if (!u.totp_secret_sealed) throw bad('Start setup first.');
    const secret = open('app', u.totp_secret_sealed, `totp:${u.id}`);
    const counter = verifyTotp(secret, req.body.code);
    if (counter === null) throw new HttpError(401, 'invalid_code', 'That code is incorrect.');
    db.run('UPDATE users SET totp_enabled = 1, totp_last_counter = ? WHERE id = ?', counter, u.id);
    securityEvent(db, '2fa_enabled', { userId: u.id, req });
    if (siteRank(u.site_role) > 0) audit(db, { actor: u, action: 'account.2fa_enabled', targetType: 'user', targetId: u.id, req });
    res.json({ ok: true });
  }));

  r.post('/2fa/disable', h((req, res) => {
    limiter.check(`2fa:${req.user.id}`, 10, 15 * 60_000);
    if (!checkUserTotp(ctx, req.user, req.body.code)) throw new HttpError(401, 'invalid_code', 'That code is incorrect.');
    db.run('UPDATE users SET totp_enabled = 0, totp_secret_sealed = NULL, totp_last_counter = NULL WHERE id = ?', req.user.id);
    db.run('UPDATE sessions SET elevated_until = NULL WHERE user_id = ?', req.user.id);
    securityEvent(db, '2fa_disabled', { userId: req.user.id, req });
    if (siteRank(req.user.site_role) > 0) audit(db, { actor: req.user, action: 'account.2fa_disabled', targetType: 'user', targetId: req.user.id, req });
    res.json({ ok: true });
  }));

  return r;
}
