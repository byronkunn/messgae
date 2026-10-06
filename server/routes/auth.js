import { Router } from 'express';
import {
  generateAccountId, generateRecoveryKey, makeVerifier, checkVerifier, dummyCheck, normalizeAccountId,
  normalizeRecoveryKey, newId, randomBase32, randomToken, sha256, formatAccountId,
} from '../lib/crypto.js';
import { h, str, bad, HttpError, clientIp, describeDevice, notFound } from '../lib/http.js';
import { createSession, requireUser, checkUserTotp, cookieOptions } from '../lib/auth.js';
import { audit, securityEvent } from '../lib/audit.js';
import { selfView, notify } from '../lib/users.js';
import { siteRank } from '../lib/perms.js';
import { config } from '../config.js';

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'moderator', 'mod', 'staff', 'official', 'security',
  'messgae', 'everyone', 'here', 'null', 'undefined', 'api', 'settings', 'explore', 'files',
]);

export function validateUsername(db, username, selfId = null) {
  const u = str(username, 'Username', { min: 3, max: 32 });
  if (!USERNAME_RE.test(u)) throw bad('Usernames use 3–32 letters, numbers or underscores.');
  if (RESERVED.has(u.toLowerCase())) throw bad('That username is reserved.');
  const taken = db.get('SELECT id FROM users WHERE username = ?', u);
  if (taken && taken.id !== selfId) throw bad('That username is taken.', 'username_taken');
  return u;
}

function uniqueAccountId(db) {
  for (let i = 0; i < 10; i++) {
    const id = generateAccountId();
    if (!db.get('SELECT 1 FROM users WHERE account_id = ?', id)) return id;
  }
  throw new Error('Could not allocate account id');
}

function suggestUsername(db, displayName) {
  const base = String(displayName || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  for (let i = 0; i < 20; i++) {
    const candidate = `${base.length >= 3 ? base : 'user'}${i === 0 && base.length >= 3 ? '' : Math.floor(1000 + Math.random() * 9000)}`;
    if (!RESERVED.has(candidate) && !ctxTaken(db, candidate)) return candidate;
  }
  return `user${randomBase32(8).toLowerCase()}`;
}
const ctxTaken = (db, u) => !!db.get('SELECT 1 FROM users WHERE username = ?', u);

export default function authRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;

  r.get('/username-available', h((req, res) => {
    limiter.check(`uname:${req.ip}`, 60, 60_000);
    try {
      validateUsername(db, req.query.u, req.user?.id);
      res.json({ available: true });
    } catch (err) {
      res.json({ available: false, reason: err.message });
    }
  }));

  /** Private account creation: no email, phone or password. */
  r.post('/register', h((req, res) => {
    limiter.check(`register:${req.ip}`, config.isTest ? 1000 : 10, 60 * 60_000);
    const displayName = str(req.body.displayName, 'Display name', { min: 1, max: 48 });
    const username = req.body.username ? validateUsername(db, req.body.username) : suggestUsername(db, displayName);
    const accountId = uniqueAccountId(db);
    const recoveryKey = generateRecoveryKey();
    const user = {
      id: newId('usr'),
      account_id: accountId,
      username,
      display_name: displayName,
      recovery_verifier: makeVerifier(normalizeRecoveryKey(recoveryKey)),
      created_at: Date.now(),
    };
    db.run(
      `INSERT INTO users (id, account_id, username, display_name, recovery_verifier, recovery_rotated_at, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      user.id, user.account_id, user.username, user.display_name, user.recovery_verifier, user.created_at, user.created_at, user.created_at,
    );
    const full = db.get('SELECT * FROM users WHERE id = ?', user.id);
    createSession(ctx, res, req, full, req.body.deviceName);
    securityEvent(db, 'register', { userId: user.id, req });
    // The recovery key is shown exactly once; only its scrypt verifier is stored.
    res.status(201).json({ user: selfView(ctx, full), accountId: formatAccountId(accountId), recoveryKey });
  }));

  /** Sign in with Account ID + Recovery Key (e.g. new device when no other device is available). */
  r.post('/login', h((req, res) => {
    limiter.check(`login:${req.ip}`, config.isTest ? 1000 : 20, 15 * 60_000);
    const accountId = normalizeAccountId(req.body.accountId);
    const key = normalizeRecoveryKey(req.body.recoveryKey);
    if (accountId.length !== 24 || key.length !== 32) {
      throw bad('Enter your 24-digit Account ID and 32-character Recovery Key.');
    }
    const user = db.get('SELECT * FROM users WHERE account_id = ?', accountId);
    if (!user) {
      dummyCheck(key);
      securityEvent(db, 'login_failed', { req, detail: { reason: 'unknown_account' } });
      throw new HttpError(401, 'invalid_credentials', 'Account ID or Recovery Key is incorrect.');
    }
    if (user.locked_until && user.locked_until > Date.now()) {
      const secs = Math.ceil((user.locked_until - Date.now()) / 1000);
      throw new HttpError(429, 'locked', `Too many failed attempts. Try again in ${secs}s.`, { retryAfter: secs });
    }
    if (!checkVerifier(key, user.recovery_verifier)) {
      const fails = user.failed_logins + 1;
      // Exponential lockout after 5 consecutive failures: 1 min, 2, 4 ... capped at 24h.
      const lock = fails >= 5 ? Date.now() + Math.min(24 * 3600_000, 60_000 * 2 ** (fails - 5)) : null;
      db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, lock, user.id);
      securityEvent(db, 'login_failed', { userId: user.id, req, detail: { fails } });
      throw new HttpError(401, 'invalid_credentials', 'Account ID or Recovery Key is incorrect.');
    }
    if (user.state === 'banned' || (user.state === 'suspended' && !(user.state_until && user.state_until <= Date.now()))) {
      throw new HttpError(403, `account_${user.state}`, `This account is ${user.state}.`, { reason: user.state_reason, until: user.state_until });
    }
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
    createSession(ctx, res, req, user, req.body.deviceName);
    securityEvent(db, 'login', { userId: user.id, req, detail: { method: 'recovery_key' } });
    if (siteRank(user.site_role) > 0) audit(db, { actor: user, action: 'admin.login', targetType: 'user', targetId: user.id, req });
    res.json({ user: selfView(ctx, db.get('SELECT * FROM users WHERE id = ?', user.id)) });
  }));

  r.post('/logout', (req, res) => {
    if (req.session) {
      db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', Date.now(), req.session.id);
      ctx.hub.closeSession(req.session.id);
    }
    res.clearCookie(config.sessionCookie, { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });

  // ---- Device linking: the NEW device requests, an already signed-in device approves. ----

  r.post('/link/start', h((req, res) => {
    limiter.check(`linkstart:${req.ip}`, config.isTest ? 1000 : 20, 15 * 60_000);
    const dev = describeDevice(req.get('user-agent'));
    const code = randomBase32(8);
    const pollToken = randomToken(24);
    const link = {
      id: newId('lnk'),
      code,
      expires_at: Date.now() + 5 * 60_000,
    };
    db.run(
      `INSERT INTO device_links (id, code, poll_hash, device_name, device_type, user_agent, ip, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      link.id, code, sha256(pollToken), String(req.body.deviceName || dev.name).slice(0, 80), dev.type,
      String(req.get('user-agent') || '').slice(0, 300), clientIp(req), link.expires_at, Date.now(),
    );
    res.json({
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      pollToken,
      expiresAt: link.expires_at,
      approveUrl: `${config.publicOrigin}/link-device#${code}`,
    });
  }));

  r.post('/link/poll', h((req, res) => {
    limiter.check(`linkpoll:${req.ip}`, config.isTest ? 1000 : 120, 60_000);
    const link = db.get('SELECT * FROM device_links WHERE poll_hash = ?', sha256(String(req.body.pollToken || '')));
    if (!link || link.consumed_at) throw notFound('Link request');
    if (link.expires_at < Date.now()) return res.json({ status: 'expired' });
    if (!link.approved_by) return res.json({ status: 'pending' });
    const user = db.get('SELECT * FROM users WHERE id = ?', link.approved_by);
    db.run('UPDATE device_links SET consumed_at = ? WHERE id = ?', Date.now(), link.id);
    createSession(ctx, res, req, user, link.device_name);
    securityEvent(db, 'login', { userId: user.id, req, detail: { method: 'device_link' } });
    res.json({ status: 'approved', user: selfView(ctx, user) });
  }));

  const findLink = (code) => {
    const clean = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    const link = db.get('SELECT * FROM device_links WHERE code = ?', clean);
    if (!link || link.consumed_at || link.approved_by || link.expires_at < Date.now()) throw notFound('Device link code');
    return link;
  };

  r.get('/link/:code', requireUser, h((req, res) => {
    limiter.check(`linklookup:${req.user.id}`, 30, 60_000);
    const link = findLink(req.params.code);
    res.json({ deviceName: link.device_name, deviceType: link.device_type, ip: link.ip, createdAt: link.created_at, expiresAt: link.expires_at });
  }));

  r.post('/link/:code/approve', requireUser, h((req, res) => {
    limiter.check(`linklookup:${req.user.id}`, 30, 60_000);
    const link = findLink(req.params.code);
    db.run('UPDATE device_links SET approved_by = ?, approved_session_id = ? WHERE id = ?', req.user.id, req.session.id, link.id);
    securityEvent(db, 'device_link_approved', { userId: req.user.id, req, detail: { device: link.device_name } });
    notify(ctx, req.user.id, 'security', { message: `New device linked: ${link.device_name}` });
    res.json({ ok: true });
  }));

  /** Short-lived privileged session for staff (2FA re-authentication). */
  r.post('/elevate', requireUser, h((req, res) => {
    limiter.check(`elevate:${req.user.id}`, 10, 15 * 60_000);
    if (!req.user.totp_enabled) throw new HttpError(403, 'staff_2fa_required', 'Enable two-factor authentication first.');
    if (!checkUserTotp(ctx, req.user, req.body.code)) {
      securityEvent(db, 'elevate_failed', { userId: req.user.id, req });
      throw new HttpError(401, 'invalid_code', 'That code is incorrect or already used.');
    }
    const until = Date.now() + config.elevationTtlMs;
    db.run('UPDATE sessions SET elevated_until = ? WHERE id = ?', until, req.session.id);
    audit(db, { actor: req.user, action: 'admin.reauthenticated', targetType: 'session', targetId: req.session.id, req });
    res.json({ elevatedUntil: until });
  }));

  return r;
}
