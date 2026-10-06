import { h, bad, forbidden, notFound, oneOf, int, bool } from '../../lib/http.js';
import { requireCap, revokeSession } from '../../lib/auth.js';
import { paginate } from '../../lib/pagination.js';
import { audit } from '../../lib/audit.js';
import { siteRank, SITE_ROLES, hasCap } from '../../lib/perms.js';
import { notify, privacyOf } from '../../lib/users.js';
import { normalizeAccountId } from '../../lib/crypto.js';
import { requireReason, modAction, userRow } from './common.js';
import { config } from '../../config.js';

export default function adminUsers(r, ctx) {
  const { db } = ctx;

  const target = (req) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) throw notFound('User');
    return u;
  };

  /** Staff may only act on accounts with a lower site role than their own. */
  const outranks = (actor, u) => {
    if (actor.id === u.id) throw forbidden('You cannot moderate your own account.');
    if (siteRank(u.site_role) >= siteRank(actor.site_role)) throw forbidden('You cannot act on staff with an equal or higher role.');
  };

  r.get('/users', requireCap('users.view'), h((req, res) => {
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) {
      const digits = normalizeAccountId(q);
      where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.id = ? OR u.account_id = ?)");
      const like = `${q.replace(/^@/, '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, q, digits || '-');
    }
    if (req.query.role) { where.push('u.site_role = ?'); params.push(oneOf(req.query.role, 'role', SITE_ROLES)); }
    if (req.query.state) { where.push('u.state = ?'); params.push(oneOf(req.query.state, 'state', ['active', 'restricted', 'suspended', 'banned'])); }
    if (req.query.plan) { where.push('u.plan = ?'); params.push(oneOf(req.query.plan, 'plan', Object.keys(config.plans))); }
    res.json(paginate(db, {
      columns: 'u.*', from: 'users u', where, params, query: req.query,
      sorts: { created: 'u.created_at', last_seen: 'COALESCE(u.last_seen_at, 0)', username: 'u.username' },
      defaultSort: 'created', idCol: 'u.id', map: userRow,
    }));
  }));

  r.get('/users/:id', requireCap('users.view'), h((req, res) => {
    const u = target(req);
    const canSecurity = hasCap(req.user, 'users.security');
    const stats = {
      messages: Number(db.value('SELECT COUNT(*) FROM messages WHERE sender_id = ?', u.id)),
      messages7d: Number(db.value('SELECT COUNT(*) FROM messages WHERE sender_id = ? AND created_at > ?', u.id, Date.now() - 7 * 86400_000)),
      files: Number(db.value('SELECT COUNT(*) FROM files WHERE owner_id = ? AND purged_at IS NULL', u.id)),
      storageBytes: Number(db.value('SELECT COALESCE(SUM(size),0) FROM files WHERE owner_id = ? AND purged_at IS NULL', u.id)),
      bandwidthBytes: Number(db.value('SELECT COALESCE(SUM(bandwidth_bytes),0) FROM files WHERE owner_id = ?', u.id)),
      groups: Number(db.value("SELECT COUNT(*) FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = ? AND c.type = 'group'", u.id)),
      spaces: Number(db.value('SELECT COUNT(*) FROM space_members WHERE user_id = ?', u.id)),
      ownedSpaces: Number(db.value('SELECT COUNT(*) FROM spaces WHERE owner_id = ? AND removed_at IS NULL', u.id)),
      reportsAgainst: Number(db.value("SELECT COUNT(*) FROM reports WHERE target_type = 'user' AND target_id = ?", u.id)),
      reportsFiled: Number(db.value('SELECT COUNT(*) FROM reports WHERE reporter_id = ?', u.id)),
      activeLinks: Number(db.value('SELECT COUNT(*) FROM file_links WHERE created_by = ? AND revoked_at IS NULL', u.id)),
    };
    const sessions = db.all('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_active_at DESC LIMIT 20', u.id)
      .map((s) => ({ id: s.id, deviceName: s.device_name, deviceType: s.device_type, createdAt: s.created_at, lastActiveAt: s.last_active_at, ip: canSecurity ? s.ip : undefined }));
    const moderation = db.all(
      `SELECT a.*, s.username AS actor_username FROM moderation_actions a LEFT JOIN users s ON s.id = a.actor_id
       WHERE a.target_type = 'user' AND a.target_id = ? ORDER BY a.created_at DESC LIMIT 50`, u.id,
    ).map((a) => ({ id: a.id, action: a.action, scope: a.scope, reason: a.reason, actor: a.actor_username, createdAt: a.created_at, expiresAt: a.expires_at }));
    res.json({
      user: { ...userRow(u), bio: u.bio, statusText: u.status_text, stateReason: u.state_reason, failedLogins: u.failed_logins, lockedUntil: u.locked_until, recoveryRotatedAt: u.recovery_rotated_at, privacy: privacyOf(u) },
      stats, sessions, moderation,
    });
  }));

  function setState(req, u, state, { hours = null, reason }) {
    const until = hours ? Date.now() + hours * 3600_000 : null;
    db.run('UPDATE users SET state = ?, state_until = ?, state_reason = ? WHERE id = ?', state, until, reason, u.id);
    if (state === 'suspended' || state === 'banned') {
      for (const s of db.all('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', u.id)) revokeSession(ctx, s.id);
      ctx.hub.closeUser(u.id);
    }
    return until;
  }

  r.post('/users/:id/warn', requireCap('users.warn'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    const reason = requireReason(req);
    notify(ctx, u.id, 'moderation', { action: 'warning', reason, from: 'Platform moderation' });
    modAction(db, { actorId: req.user.id, targetType: 'user', targetId: u.id, action: 'warn', reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: 'user.warned', targetType: 'user', targetId: u.id, reason, req });
    res.json({ ok: true });
  }));

  r.post('/users/:id/restrict', requireCap('users.restrict'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    const reason = requireReason(req);
    const hours = int(req.body.hours, 'Hours', { min: 1, max: 24 * 90, fallback: 24 });
    const until = setState(req, u, 'restricted', { hours, reason });
    notify(ctx, u.id, 'moderation', { action: 'restricted', reason, until });
    modAction(db, { actorId: req.user.id, targetType: 'user', targetId: u.id, action: 'restrict', reason, reportId: req.body.reportId, expiresAt: until });
    audit(db, { actor: req.user, action: 'user.restricted', targetType: 'user', targetId: u.id, reason, detail: { hours }, req });
    res.json({ ok: true, until });
  }));

  r.post('/users/:id/suspend', requireCap('users.suspend'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    const reason = requireReason(req);
    // Moderators may suspend temporarily; indefinite suspensions need an admin.
    const hours = req.body.hours ? int(req.body.hours, 'Hours', { min: 1, max: 24 * 365 }) : null;
    if (!hours && !hasCap(req.user, 'users.ban')) throw forbidden('Moderators can only suspend for a fixed time.');
    const until = setState(req, u, 'suspended', { hours, reason });
    modAction(db, { actorId: req.user.id, targetType: 'user', targetId: u.id, action: 'suspend', reason, reportId: req.body.reportId, expiresAt: until });
    audit(db, { actor: req.user, action: 'user.suspended', targetType: 'user', targetId: u.id, reason, detail: { hours }, req });
    res.json({ ok: true, until });
  }));

  r.post('/users/:id/ban', requireCap('users.ban'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    const reason = requireReason(req);
    setState(req, u, 'banned', { reason });
    if (bool(req.body.revokeLinks, true)) db.run('UPDATE file_links SET revoked_at = COALESCE(revoked_at, ?) WHERE created_by = ?', Date.now(), u.id);
    modAction(db, { actorId: req.user.id, targetType: 'user', targetId: u.id, action: 'ban', reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: 'user.banned', targetType: 'user', targetId: u.id, reason, req });
    res.json({ ok: true });
  }));

  r.post('/users/:id/reinstate', requireCap('users.suspend'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    if (u.state === 'banned' && !hasCap(req.user, 'users.ban')) throw forbidden('Only admins can lift bans.');
    const reason = requireReason(req);
    db.run("UPDATE users SET state = 'active', state_until = NULL, state_reason = NULL WHERE id = ?", u.id);
    modAction(db, { actorId: req.user.id, targetType: 'user', targetId: u.id, action: 'reinstate', reason });
    audit(db, { actor: req.user, action: 'user.reinstated', targetType: 'user', targetId: u.id, reason, detail: { previous: u.state }, req });
    res.json({ ok: true });
  }));

  r.post('/users/:id/revoke-sessions', requireCap('users.security'), h((req, res) => {
    const u = target(req);
    if (u.id !== req.user.id) outranks(req.user, u);
    const reason = requireReason(req);
    const sessions = db.all('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', u.id);
    for (const s of sessions) revokeSession(ctx, s.id);
    audit(db, { actor: req.user, action: 'user.sessions_revoked', targetType: 'user', targetId: u.id, reason, detail: { count: sessions.length }, req });
    res.json({ revoked: sessions.length });
  }));

  r.post('/users/:id/reset-2fa', requireCap('users.security'), h((req, res) => {
    const u = target(req);
    outranks(req.user, u);
    const reason = requireReason(req);
    db.run('UPDATE users SET totp_enabled = 0, totp_secret_sealed = NULL, totp_last_counter = NULL WHERE id = ?', u.id);
    audit(db, { actor: req.user, action: 'user.2fa_reset', targetType: 'user', targetId: u.id, reason, req });
    res.json({ ok: true });
  }));

  r.post('/users/:id/unlock', requireCap('users.security'), h((req, res) => {
    const u = target(req);
    const reason = requireReason(req);
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
    audit(db, { actor: req.user, action: 'user.login_unlocked', targetType: 'user', targetId: u.id, reason, req });
    res.json({ ok: true });
  }));

  r.patch('/users/:id/plan', requireCap('users.plan'), h((req, res) => {
    const u = target(req);
    const plan = oneOf(req.body.plan, 'Plan', Object.keys(config.plans));
    const reason = requireReason(req);
    db.run('UPDATE users SET plan = ? WHERE id = ?', plan, u.id);
    audit(db, { actor: req.user, action: 'user.plan_changed', targetType: 'user', targetId: u.id, reason, detail: { from: u.plan, to: plan }, req });
    res.json({ ok: true });
  }));

  /** Staff roles and Evidence Access (Super Admin only, privileged session). */
  r.patch('/users/:id/staff', requireCap('staff.manage'), h((req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw forbidden('You cannot change your own staff permissions.');
    const reason = requireReason(req);
    const role = req.body.role !== undefined ? oneOf(req.body.role, 'Role', SITE_ROLES) : u.site_role;
    const evidence = req.body.evidenceAccess !== undefined ? (bool(req.body.evidenceAccess) ? 1 : 0) : u.evidence_access;
    if (u.site_role === 'super_admin' && role !== 'super_admin') {
      const supers = Number(db.value("SELECT COUNT(*) FROM users WHERE site_role = 'super_admin'"));
      if (supers <= 1) throw bad('There must always be at least one Super Admin.');
    }
    if (evidence && siteRank(role) < siteRank('site_admin')) throw bad('Evidence Access can only be granted to Admins or Super Admins.');
    db.run('UPDATE users SET site_role = ?, evidence_access = ? WHERE id = ?', role, evidence, u.id);
    // Force re-elevation after any permission change.
    db.run('UPDATE sessions SET elevated_until = NULL WHERE user_id = ?', u.id);
    audit(db, {
      actor: req.user, action: 'staff.permissions_changed', targetType: 'user', targetId: u.id, reason,
      detail: { from: { role: u.site_role, evidenceAccess: !!u.evidence_access }, to: { role, evidenceAccess: !!evidence } }, req,
    });
    res.json({ ok: true });
  }));

  r.get('/staff', requireCap('users.view'), h((req, res) => {
    const rows = db.all("SELECT * FROM users WHERE site_role != 'user' ORDER BY site_role DESC, username");
    res.json({ staff: rows.map(userRow) });
  }));

  /** Data export for lawful requests. Privileged + audited. */
  r.post('/users/:id/export', requireCap('data.export'), h((req, res) => {
    const u = target(req);
    const reason = requireReason(req);
    const data = {
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.username,
      reason,
      account: { ...userRow(u), bio: u.bio, links: JSON.parse(u.links || '[]'), privacy: privacyOf(u) },
      sessions: db.all('SELECT id, device_name, device_type, ip, created_at, last_active_at, revoked_at FROM sessions WHERE user_id = ?', u.id),
      contacts: db.all('SELECT contact_id, created_at FROM contacts WHERE user_id = ?', u.id),
      files: db.all('SELECT id, filename, mime, size, sha256, created_at, trashed_at, purged_at, moderation_status FROM files WHERE owner_id = ?', u.id),
      links: db.all('SELECT id, file_id, audience, expires_at, max_downloads, downloads, created_at, revoked_at FROM file_links WHERE created_by = ?', u.id),
      memberships: {
        conversations: db.all('SELECT conversation_id, role, joined_at FROM conversation_members WHERE user_id = ?', u.id),
        spaces: db.all('SELECT space_id, joined_at FROM space_members WHERE user_id = ?', u.id),
      },
      messages: db.all('SELECT id, conversation_id, kind, body, created_at, edited_at, deleted_at FROM messages WHERE sender_id = ? ORDER BY created_at LIMIT 100000', u.id),
      moderation: db.all("SELECT * FROM moderation_actions WHERE target_type = 'user' AND target_id = ?", u.id),
    };
    audit(db, { actor: req.user, action: 'data.exported', targetType: 'user', targetId: u.id, reason, detail: { messages: data.messages.length, files: data.files.length }, req });
    res.setHeader('Content-Disposition', `attachment; filename="export-${u.username}-${Date.now()}.json"`);
    res.json(data);
  }));

  r.get('/sessions', requireCap('users.security'), h((req, res) => {
    const where = ['s.revoked_at IS NULL'];
    const params = [];
    if (req.query.userId) { where.push('s.user_id = ?'); params.push(String(req.query.userId)); }
    res.json(paginate(db, {
      columns: 's.id, s.user_id, s.device_name, s.device_type, s.ip, s.created_at, s.last_active_at, u.username',
      from: 'sessions s JOIN users u ON u.id = s.user_id', where, params, query: req.query,
      sorts: { last_active: 's.last_active_at', created: 's.created_at' }, defaultSort: 'last_active', idCol: 's.id',
      map: (s) => ({ id: s.id, userId: s.user_id, username: s.username, deviceName: s.device_name, deviceType: s.device_type, ip: s.ip, createdAt: s.created_at, lastActiveAt: s.last_active_at }),
    }));
  }));

  r.delete('/sessions/:sid', requireCap('users.security'), h((req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE id = ?', req.params.sid);
    if (!s) throw notFound('Session');
    const reason = requireReason(req);
    revokeSession(ctx, s.id);
    audit(db, { actor: req.user, action: 'session.revoked', targetType: 'session', targetId: s.id, reason, detail: { userId: s.user_id }, req });
    res.json({ ok: true });
  }));

}
