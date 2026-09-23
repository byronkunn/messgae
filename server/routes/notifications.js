import { Router } from 'express';
import { h } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';

export default function notificationRoutes(ctx) {
  const r = Router();
  const { db } = ctx;
  r.use(requireUser);

  r.get('/', h((req, res) => {
    const params = [req.user.id];
    let seek = '';
    if (req.query.before) {
      const [t, id] = String(req.query.before).split('~');
      seek = 'AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(Number(t), Number(t), id || '');
    }
    const rows = db.all(`SELECT * FROM notifications WHERE user_id = ? ${seek} ORDER BY created_at DESC, id DESC LIMIT 50`, ...params);
    const last = rows[rows.length - 1];
    res.json({
      notifications: rows.map((n) => ({ id: n.id, type: n.type, data: JSON.parse(n.data), createdAt: n.created_at, readAt: n.read_at })),
      nextCursor: rows.length === 50 ? `${last.created_at}~${last.id}` : null,
      unread: Number(db.value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id)),
    });
  }));

  r.post('/read-all', h((req, res) => {
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), req.user.id);
    res.json({ ok: true });
  }));

  r.post('/:id/read', h((req, res) => {
    db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?', Date.now(), req.params.id, req.user.id);
    res.json({ ok: true });
  }));

  r.delete('/:id', h((req, res) => {
    db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    res.json({ ok: true });
  }));

  return r;
}
