import { str, bad } from '../../lib/http.js';
import { newId } from '../../lib/crypto.js';

export const HOUR = 3600_000;
export const DAY = 86400_000;

/** Sensitive admin access must state an investigation reason (body, header or query). */
export function requireReason(req) {
  const raw = req.body?.reason || req.get('x-investigation-reason') || req.query.reason;
  const reason = str(raw ? decodeURIComponent(String(raw)) : '', 'Investigation reason', { min: 5, max: 500 });
  return reason;
}

/** Parses ?range=1h|24h|7d|30d|90d|custom&from=&to= into a time window and bucket size. */
export function parseRange(q, fallback = '7d') {
  const range = q.range || fallback;
  const to = Date.now();
  const presets = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };
  if (range === 'custom') {
    const from = Number(new Date(q.from));
    const end = q.to ? Number(new Date(q.to)) + (String(q.to).length <= 10 ? DAY - 1 : 0) : to;
    if (!Number.isFinite(from) || !Number.isFinite(end) || from >= end) throw bad('Choose a valid custom date range.');
    if (end - from > 366 * DAY) throw bad('Custom ranges are limited to one year.');
    const span = end - from;
    return { range, from, to: end, span, bucket: span <= 2 * DAY ? HOUR : DAY };
  }
  const span = presets[range];
  if (!span) throw bad('Unknown range.');
  return { range, from: to - span, to, span, bucket: span <= 2 * DAY ? (span <= HOUR ? 5 * 60_000 : HOUR) : DAY };
}

/** Fills empty buckets so charts have continuous series. */
export function series(rows, from, to, bucket, keys = ['value']) {
  const map = new Map(rows.map((r) => [Number(r.b), r]));
  const out = [];
  for (let b = Math.floor(from / bucket); b <= Math.floor(to / bucket); b++) {
    const r = map.get(b) || {};
    const point = { t: b * bucket };
    for (const k of keys) point[k] = Number(r[k] || 0);
    out.push(point);
  }
  return out;
}

export function modAction(db, { actorId, targetType, targetId, action, reason = null, reportId = null, expiresAt = null }) {
  db.run(
    `INSERT INTO moderation_actions (id, actor_id, scope, target_type, target_id, action, reason, report_id, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId('mod'), actorId, 'site', targetType, targetId, action, reason, reportId, expiresAt, Date.now(),
  );
}

export function userRow(u) {
  return {
    id: u.id,
    accountId: u.account_id,
    username: u.username,
    displayName: u.display_name,
    siteRole: u.site_role,
    state: u.state,
    stateUntil: u.state_until,
    plan: u.plan,
    totpEnabled: !!u.totp_enabled,
    evidenceAccess: !!u.evidence_access,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    avatarFileId: u.avatar_file_id,
  };
}

export function fileRow(f) {
  return {
    id: f.id,
    filename: f.filename,
    mime: f.mime,
    category: f.category,
    size: f.size,
    sha256: f.sha256,
    ownerId: f.owner_id,
    ownerUsername: f.owner_username,
    createdAt: f.created_at,
    downloads: f.download_count,
    shares: f.share_count,
    views: f.view_count,
    bandwidth: f.bandwidth_bytes,
    moderationStatus: f.moderation_status,
    passwordProtected: !!f.password_verifier,
    trashed: !!f.trashed_at,
    purged: !!f.purged_at,
    ...(f.recent !== undefined ? { recent: f.recent, baseline: f.baseline } : {}),
  };
}
