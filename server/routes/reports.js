import { Router } from 'express';
import { h, str, oneOf, notFound } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import { conversationAccess } from '../lib/perms.js';
import { fileAccess } from '../lib/files.js';
import { serializeMessage } from '../lib/messaging.js';
import { reportRow } from './spaces.js';

export const REPORT_REASONS = ['spam', 'scam', 'harassment', 'hate', 'violence', 'sexual_content', 'child_safety', 'illegal', 'impersonation', 'malware', 'copyright', 'self_harm', 'other'];

export default function reportRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  /**
   * Files a report. An evidence snapshot of what the reporter could see is stored with it,
   * so moderators review exactly what was reported even if it is edited or deleted later.
   */
  r.post('/', h((req, res) => {
    limiter.check(`report:${req.user.id}`, 20, 60 * 60_000);
    const targetType = oneOf(req.body.targetType, 'Target type', ['user', 'message', 'conversation', 'space', 'file']);
    const targetId = str(req.body.targetId, 'Target', { min: 1, max: 64 });
    const reason = oneOf(req.body.reason, 'Reason', REPORT_REASONS);
    const details = str(req.body.details, 'Details', { max: 2000 });
    let evidence = {};
    let spaceId = null;
    let conversationId = null;

    if (targetType === 'message') {
      const m = db.get('SELECT * FROM messages WHERE id = ?', targetId);
      if (!m) throw notFound('Message');
      const a = conversationAccess(db, req.user.id, m.conversation_id);
      if (!a.can.view) throw notFound('Message');
      const context = db.all(
        `SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS ? AND created_at <= ? AND created_at > ?
         ORDER BY created_at DESC LIMIT 6`, m.conversation_id, m.thread_id, m.created_at, a.member?.cleared_at || 0,
      ).reverse();
      evidence = { message: serializeMessage(ctx, m), context: context.map((c) => serializeMessage(ctx, c)), conversationType: a.conv.type };
      conversationId = m.conversation_id;
      spaceId = a.conv.space_id;
    } else if (targetType === 'user') {
      const u = db.get('SELECT * FROM users WHERE id = ?', targetId);
      if (!u) throw notFound('User');
      evidence = { user: { id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, statusText: u.status_text, links: JSON.parse(u.links || '[]') } };
      if (req.body.spaceId && db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', req.body.spaceId, req.user.id)) spaceId = req.body.spaceId;
    } else if (targetType === 'conversation') {
      const a = conversationAccess(db, req.user.id, targetId);
      evidence = { conversation: { id: a.conv.id, type: a.conv.type, name: a.conv.name, description: a.conv.description } };
      conversationId = a.conv.id;
      spaceId = a.conv.space_id;
    } else if (targetType === 'space') {
      const s = db.get('SELECT * FROM spaces WHERE id = ? AND removed_at IS NULL', targetId);
      if (!s || (s.visibility !== 'public' && !db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', s.id, req.user.id))) throw notFound('Space');
      evidence = { space: { id: s.id, name: s.name, description: s.description } };
    } else if (targetType === 'file') {
      const f = db.get('SELECT * FROM files WHERE id = ?', targetId);
      if (!fileAccess(db, req.user.id, f).ok) throw notFound('File');
      evidence = { file: { id: f.id, filename: f.filename, size: f.size, mime: f.mime, sha256: f.sha256, ownerId: f.owner_id } };
      conversationId = f.origin_conversation_id;
    }

    const id = newId('rep');
    const t = Date.now();
    db.run(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, evidence, space_id, conversation_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.user.id, targetType, targetId, reason, details, JSON.stringify(evidence), spaceId, conversationId, t, t,
    );
    res.status(201).json({ id });
  }));

  r.get('/mine', h((req, res) => {
    const rows = db.all('SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id);
    res.json({ reports: rows.map((x) => ({ ...reportRow(x), evidence: undefined })) });
  }));

  return r;
}
