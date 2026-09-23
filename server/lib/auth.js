import { config } from '../config.js';
import { newId, randomToken, sha256, verifyTotp, open } from './crypto.js';
import { HttpError, clientIp, describeDevice, forbidden } from './http.js';
import { siteCaps, ELEVATED_CAPS } from './perms.js';
import { audit } from './audit.js';

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlMs,
  };
}

export function createSession(ctx, res, req, user, deviceNameOverride) {
  const token = randomToken(32);
  const dev = describeDevice(req.get('user-agent'));
  const session = {
    id: newId('ses'),
    user_id: user.id,
    token_hash: sha256(token),
    device_name: (deviceNameOverride || dev.name).slice(0, 80),
    device_type: dev.type,
    user_agent: String(req.get('user-agent') || '').slice(0, 300),
    ip: clientIp(req),
    created_at: Date.now(),
  };
  ctx.db.run(
    `INSERT INTO sessions (id, user_id, token_hash, device_name, device_type, user_agent, ip, created_at, last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    session.id, session.user_id, session.token_hash, session.device_name, session.device_type, session.user_agent,
    session.ip, session.created_at, session.created_at,
  );
  res.cookie(config.sessionCookie, token, cookieOptions());
  return session;
}

/** Lifts time-limited restrictions/suspensions whose period has ended. */
export function refreshUserState(db, user) {
  if (user && (user.state === 'restricted' || user.state === 'suspended') && user.state_until && user.state_until <= Date.now()) {
    db.run("UPDATE users SET state = 'active', state_until = NULL, state_reason = NULL WHERE id = ?", user.id);
    return { ...user, state: 'active', state_until: null, state_reason: null };
  }
  return user;
}

export function sessionFromToken(ctx, token) {
  if (!token) return null;
  const { db } = ctx;
  const session = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!session || session.revoked_at) return null;
  if (session.last_active_at + config.sessionTtlMs < Date.now()) return null;
  let user = db.get('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user) return null;
  user = refreshUserState(db, user);
  return { session, user };
}

export function attachAuth(ctx) {
  return (req, _res, next) => {
    const auth = sessionFromToken(ctx, req.cookies?.[config.sessionCookie]);
    if (auth) {
      req.session = auth.session;
      req.user = auth.user;
      const t = Date.now();
      if (t - auth.session.last_active_at > 60_000) {
        ctx.db.run('UPDATE sessions SET last_active_at = ?, ip = ? WHERE id = ?', t, clientIp(req), auth.session.id);
        ctx.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', t, auth.user.id);
      }
    }
    next();
  };
}

export function authenticateUpgrade(ctx, req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${config.sessionCookie}=`));
  const token = match ? decodeURIComponent(match.slice(config.sessionCookie.length + 1)) : null;
  const auth = sessionFromToken(ctx, token);
  if (!auth || ['suspended', 'banned'].includes(auth.user.state)) return null;
  return auth;
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in.'));
  if (req.user.state === 'suspended' || req.user.state === 'banned') {
    return next(new HttpError(403, 'account_' + req.user.state, `This account is ${req.user.state}.`, {
      reason: req.user.state_reason, until: req.user.state_until,
    }));
  }
  next();
}

/** Blocks write actions for restricted accounts (they may still read and message existing contacts). */
export function notRestricted(req) {
  if (req.user.state === 'restricted') {
    throw new HttpError(403, 'account_restricted', 'Your account is temporarily restricted from this action.', {
      reason: req.user.state_reason, until: req.user.state_until,
    });
  }
}

/**
 * Staff gate: requires a site capability. Staff accounts must have 2FA enabled to use
 * any admin capability; ELEVATED capabilities additionally require a recent 2FA
 * re-authentication (short-lived privileged session).
 */
export function requireCap(cap, { elevated = ELEVATED_CAPS.has(cap) } = {}) {
  return (req, _res, next) => {
    try {
      if (!req.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
      const caps = siteCaps(req.user);
      if (!caps.has(cap)) throw forbidden('Your staff role does not include this permission.');
      if (!req.user.totp_enabled) {
        throw new HttpError(403, 'staff_2fa_required', 'Staff accounts must enable two-factor authentication first (Settings → Security).');
      }
      if (elevated && !(req.session.elevated_until > Date.now())) {
        throw new HttpError(403, 'reauth_required', 'Confirm your identity with your authenticator code to continue.');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function isElevated(req) {
  return req.session?.elevated_until > Date.now();
}

/** Verifies a TOTP code for a user with replay protection. */
export function checkUserTotp(ctx, user, code) {
  if (!user.totp_enabled || !user.totp_secret_sealed) return false;
  const secret = open('app', user.totp_secret_sealed, `totp:${user.id}`);
  const counter = verifyTotp(secret, code);
  if (counter === null) return false;
  if (user.totp_last_counter !== null && counter <= user.totp_last_counter) return false; // replayed code
  ctx.db.run('UPDATE users SET totp_last_counter = ? WHERE id = ?', counter, user.id);
  return true;
}

export function revokeSession(ctx, sessionId, actor, req) {
  ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), sessionId);
  ctx.hub.closeSession(sessionId);
  if (actor && req) audit(ctx.db, { actor, action: 'session.revoked', targetType: 'session', targetId: sessionId, req });
}
