import fs from 'node:fs';
import path from 'node:path';
import { h } from '../../lib/http.js';
import { requireCap } from '../../lib/auth.js';
import { paginate } from '../../lib/pagination.js';
import { verifyAudit } from '../../lib/audit.js';
import { hasCap } from '../../lib/perms.js';
import { normalizeAccountId } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { DAY } from './common.js';

const auditRow = (a) => ({
  id: a.id, seq: a.seq, actorId: a.actor_id, actorUsername: a.actor_username, actorRole: a.actor_role, action: a.action,
  targetType: a.target_type, targetId: a.target_id, reason: a.reason, detail: a.detail ? safeJson(a.detail) : null,
  ip: a.ip, userAgent: a.user_agent, sessionId: a.session_id, createdAt: a.created_at, hash: a.hash,
});
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export default function adminSystem(r, ctx) {
  const { db } = ctx;

  r.get('/audit', requireCap('audit.view'), h((req, res) => {
    const where = [];
    const params = [];
    const q = req.query;
    if (q.actor) { where.push('(a.actor_id = ? OR u.username = ?)'); params.push(String(q.actor), String(q.actor).replace(/^@/, '')); }
    if (q.action) { where.push("a.action LIKE ? ESCAPE '\\'"); params.push(`${String(q.action).replace(/[%_\\]/g, (m) => `\\${m}`)}%`); }
    if (q.targetId) { where.push('a.target_id = ?'); params.push(String(q.targetId)); }
    if (q.targetType) { where.push('a.target_type = ?'); params.push(String(q.targetType)); }
    if (q.from) { where.push('a.created_at >= ?'); params.push(Number(new Date(q.from))); }
    if (q.to) { where.push('a.created_at <= ?'); params.push(Number(new Date(q.to)) + DAY - 1); }
    if (q.q) { where.push("(a.reason LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')"); const like = `%${String(q.q).replace(/[%_\\]/g, (m) => `\\${m}`)}%`; params.push(like, like); }
    res.json(paginate(db, {
      columns: 'a.*, u.username AS actor_username', from: 'audit_log a LEFT JOIN users u ON u.id = a.actor_id', where, params, query: q,
      sorts: { seq: 'a.seq' }, defaultSort: 'seq', idCol: 'a.id', map: auditRow,
    }));
  }));

  r.get('/audit/actions', requireCap('audit.view'), h((req, res) => {
    res.json({ actions: db.all('SELECT action, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY action') });
  }));

  r.post('/audit/verify', requireCap('audit.verify'), h((req, res) => {
    res.json(verifyAudit(db));
  }));

  r.get('/security', requireCap('analytics.view'), h((req, res) => {
    const t = Date.now();
    res.json({
      staff: db.all("SELECT id, username, site_role, totp_enabled, evidence_access, last_seen_at FROM users WHERE site_role != 'user' ORDER BY site_role DESC")
        .map((u) => ({ id: u.id, username: u.username, role: u.site_role, totpEnabled: !!u.totp_enabled, evidenceAccess: !!u.evidence_access, lastSeenAt: u.last_seen_at })),
      recentSensitive: db.all(
        `SELECT a.*, u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.action IN ('conversation.viewed','file.downloaded','file.password_revealed','data.exported','staff.permissions_changed','user.banned','admin.reauthenticated')
         ORDER BY a.seq DESC LIMIT 25`,
      ).map(auditRow),
      failedLogins24h: Number(db.value("SELECT COUNT(*) FROM security_events WHERE type = 'login_failed' AND created_at > ?", t - DAY)),
      lockedAccounts: Number(db.value('SELECT COUNT(*) FROM users WHERE locked_until > ?', t)),
      activeSessions: Number(db.value('SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND last_active_at > ?', t - config.sessionTtlMs)),
      topFailedIps: db.all("SELECT ip, COUNT(*) AS count FROM security_events WHERE type = 'login_failed' AND created_at > ? GROUP BY ip ORDER BY count DESC LIMIT 10", t - DAY),
      controls: [
        'Staff must enable TOTP two-factor authentication before using admin tools.',
        'Sensitive actions require a privileged session (2FA re-authentication, 10 minutes).',
        'Evidence Access is a separate grant for selected Admins/Super Admins.',
        'Every sensitive action requires a reason and is written to a hash-chained, append-only audit log.',
        'Rate limiting and exponential lockout protect sign-in and password-protected links.',
      ],
    });
  }));

  r.get('/billing', requireCap('billing.view'), h((req, res) => {
    const plans = Object.entries(config.plans).map(([id, p]) => ({
      id, ...p, users: Number(db.value('SELECT COUNT(*) FROM users WHERE plan = ?', id)),
    }));
    const spacePlans = Object.entries(config.spacePlans).map(([id, p]) => ({
      id, ...p, spaces: Number(db.value('SELECT COUNT(*) FROM spaces WHERE plan = ? AND removed_at IS NULL', id)),
    }));
    const mrr = plans.reduce((a, p) => a + p.users * p.priceMonthly, 0) + spacePlans.reduce((a, p) => a + p.spaces * p.priceMonthly, 0);
    res.json({
      plans, spacePlans, estimatedMrr: Math.round(mrr * 100) / 100,
      notice: 'Plans are assigned manually by admins in this MVP. Connect a payment provider before charging customers.',
    });
  }));

  r.get('/system', requireCap('system.view'), h((req, res) => {
    const dbFile = path.join(config.dataDir, 'messgae.db');
    const stat = (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return null;
      }
    };
    res.json({
      version: JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version,
      node: process.version,
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      environment: config.isProd ? 'production' : 'development',
      database: { file: path.basename(dbFile), bytes: stat(dbFile), walBytes: stat(`${dbFile}-wal`), sqlite: db.value('SELECT sqlite_version()') },
      blobStore: { objects: Number(db.value('SELECT COUNT(*) FROM blobs WHERE deleted_at IS NULL')), bytesOnDisk: ctx.blobs.diskUsage() },
      keys: Object.fromEntries(Object.keys(config.keys).map((k) => [k, config.keys[k] ? 'environment' : config.isProd ? 'missing' : 'development key file'])),
      limits: { maxUploadBytes: config.maxUploadBytes, plans: config.plans, spacePlans: config.spacePlans },
      counts: Object.fromEntries(['users', 'sessions', 'conversations', 'messages', 'files', 'file_links', 'reports', 'audit_log', 'notifications']
        .map((t) => [t, Number(db.value(`SELECT COUNT(*) FROM ${t}`))])),
      realtime: { onlineUsers: ctx.hub.onlineUserIds().length },
    });
  }));

  /** Global search across IDs, usernames, filenames and hashes. Results link to inspectors. */
  r.get('/search', requireCap('admin.access'), h((req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const results = [];
    const like = `%${q.replace(/^@/, '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const digits = normalizeAccountId(q);
    if (hasCap(req.user, 'users.view')) {
      for (const u of db.all(
        `SELECT id, username, display_name, account_id, state FROM users
         WHERE id = ? OR account_id = ? OR username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' LIMIT 10`,
        q, digits.length >= 8 ? digits : '-', like, like,
      )) results.push({ type: 'user', id: u.id, title: `@${u.username}`, subtitle: `${u.display_name} · ${u.state}`, path: `/admin/users/${u.id}` });
    }
    if (hasCap(req.user, 'conversations.meta')) {
      for (const c of db.all(
        `SELECT id, type, name, space_id FROM conversations WHERE id = ? OR space_id = ? OR (type != 'dm' AND name LIKE ? ESCAPE '\\') LIMIT 10`, q, q, like,
      )) results.push({ type: c.type === 'dm' ? 'dm' : c.type, id: c.id, title: c.type === 'dm' ? `DM ${c.id}` : c.name, subtitle: c.type, path: `/admin/conversations/${c.id}` });
      for (const s of db.all("SELECT id, name FROM spaces WHERE id = ? OR name LIKE ? ESCAPE '\\' LIMIT 10", q, like)) {
        results.push({ type: 'space', id: s.id, title: s.name, subtitle: 'Space', path: `/admin/spaces/${s.id}` });
      }
      const m = db.get('SELECT id, conversation_id FROM messages WHERE id = ?', q);
      if (m) results.push({ type: 'message', id: m.id, title: `Message ${m.id}`, subtitle: `in ${m.conversation_id}`, path: `/admin/conversations/${m.conversation_id}?messageId=${m.id}` });
    }
    if (hasCap(req.user, 'files.inspect')) {
      for (const f of db.all(
        "SELECT id, filename, size, sha256 FROM files WHERE id = ? OR sha256 = ? OR filename LIKE ? ESCAPE '\\' ORDER BY download_count DESC LIMIT 10",
        q, q.toLowerCase(), like,
      )) results.push({ type: 'file', id: f.id, title: f.filename, subtitle: `${f.sha256.slice(0, 12)}…`, path: `/admin/files/${f.id}` });
    }
    if (hasCap(req.user, 'reports.review')) {
      const rep = db.get('SELECT id, reason FROM reports WHERE id = ?', q);
      if (rep) results.push({ type: 'report', id: rep.id, title: `Report ${rep.id}`, subtitle: rep.reason, path: `/admin/reports/${rep.id}` });
    }
    res.json({ results });
  }));

}
