import { newId, sha256 } from './crypto.js';
import { clientIp } from './http.js';

const GENESIS = 'GENESIS';

function rowDigest(prev, r) {
  return sha256(
    prev + '|' + JSON.stringify([
      r.id, r.actor_id, r.actor_role, r.action, r.target_type, r.target_id, r.reason, r.detail,
      r.ip, r.user_agent, r.session_id, r.created_at,
    ]),
  );
}

/**
 * Appends an entry to the tamper-evident audit log. Each row stores the hash of the
 * previous row, so any modification or deletion breaks the chain (see verifyAudit).
 * UPDATE/DELETE are also blocked by database triggers.
 */
export function audit(db, { actor, action, targetType = null, targetId = null, reason = null, detail = null, req = null }) {
  return db.tx(() => {
    const prev = db.get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')?.hash || GENESIS;
    const row = {
      id: newId('aud'),
      actor_id: actor?.id ?? null,
      actor_role: actor?.site_role ?? null,
      action,
      target_type: targetType,
      target_id: targetId,
      reason: reason || null,
      detail: detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
      ip: req ? clientIp(req) : null,
      user_agent: req ? String(req.get?.('user-agent') || '').slice(0, 300) : null,
      session_id: req?.session?.id ?? null,
      created_at: Date.now(),
    };
    row.prev_hash = prev;
    row.hash = rowDigest(prev, row);
    db.run(
      `INSERT INTO audit_log (id, actor_id, actor_role, action, target_type, target_id, reason, detail, ip, user_agent,
        session_id, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.actor_id, row.actor_role, row.action, row.target_type, row.target_id, row.reason, row.detail,
      row.ip, row.user_agent, row.session_id, row.created_at, row.prev_hash, row.hash,
    );
    return row;
  });
}

/** Walks the whole chain and reports the first broken link, if any. */
export function verifyAudit(db) {
  let prev = GENESIS;
  let count = 0;
  for (const r of db.raw.prepare('SELECT * FROM audit_log ORDER BY seq ASC').iterate()) {
    if (r.prev_hash !== prev || rowDigest(prev, r) !== r.hash) {
      return { ok: false, count, brokenAt: r.id, seq: r.seq };
    }
    prev = r.hash;
    count++;
  }
  return { ok: true, count, head: prev };
}

export function securityEvent(db, type, { userId = null, req = null, detail = null } = {}) {
  db.run(
    'INSERT INTO security_events (type, user_id, ip, detail, created_at) VALUES (?,?,?,?,?)',
    type, userId, req ? clientIp(req) : null, detail ? JSON.stringify(detail) : null, Date.now(),
  );
}
