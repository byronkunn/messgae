import { Router } from 'express';
import { h, notFound, bad } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { publicProfile, privacyOf, notify, miniUser } from '../lib/users.js';

export default function userRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  const target = (req) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u || u.state === 'banned') throw notFound('User');
    return u;
  };

  r.get('/search', h((req, res) => {
    limiter.check(`usersearch:${req.user.id}`, 60, 60_000);
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 2) return res.json({ users: [] });
    const like = `${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const rows = db.all(
      `SELECT * FROM users u WHERE u.state != 'banned' AND u.id != ?
         AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = u.id AND b.blocked_id = ?)
       ORDER BY (u.username = ?) DESC, u.username LIMIT 40`,
      req.user.id, like, like, req.user.id, q,
    );
    // Undiscoverable users are only found by exact username or by their contacts.
    const users = rows
      .filter((u) => privacyOf(u).discoverable || u.username.toLowerCase() === q.toLowerCase() ||
        db.get('SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?', req.user.id, u.id))
      .slice(0, 20)
      .map((u) => publicProfile(ctx, u, req.user.id));
    res.json({ users });
  }));

  r.get('/contacts', h((req, res) => {
    const rows = db.all(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = ? AND u.state != 'banned'
       ORDER BY u.display_name COLLATE NOCASE`, req.user.id,
    );
    res.json({ contacts: rows.map((u) => publicProfile(ctx, u, req.user.id)) });
  }));

  r.get('/blocked', h((req, res) => {
    const rows = db.all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?', req.user.id);
    res.json({ users: rows.map(miniUser) });
  }));

  r.get('/by-username/:username', h((req, res) => {
    const u = db.get("SELECT * FROM users WHERE username = ? AND state != 'banned'", req.params.username);
    if (!u) throw notFound('User');
    res.json({ user: publicProfile(ctx, u, req.user.id) });
  }));

  r.get('/:id', h((req, res) => {
    res.json({ user: publicProfile(ctx, target(req), req.user.id) });
  }));

  r.put('/:id/contact', h((req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('You cannot add yourself.');
    const result = db.run('INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?,?,?)', req.user.id, u.id, Date.now());
    if (result.changes && !db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', u.id, req.user.id)) {
      notify(ctx, u.id, 'contact_added', { user: miniUser(req.user) });
    }
    res.json({ ok: true });
  }));
  r.delete('/:id/contact', h((req, res) => {
    db.run('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?', req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  r.put('/:id/block', h((req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('You cannot block yourself.');
    db.run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)', req.user.id, u.id, Date.now());
    db.run('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?', req.user.id, u.id);
    res.json({ ok: true });
  }));
  r.delete('/:id/block', h((req, res) => {
    db.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  r.put('/:id/mute', h((req, res) => {
    const u = target(req);
    db.run('INSERT OR IGNORE INTO user_mutes (user_id, muted_id, created_at) VALUES (?,?,?)', req.user.id, u.id, Date.now());
    res.json({ ok: true });
  }));
  r.delete('/:id/mute', h((req, res) => {
    db.run('DELETE FROM user_mutes WHERE user_id = ? AND muted_id = ?', req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  return r;
}
