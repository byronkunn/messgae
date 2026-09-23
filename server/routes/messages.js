import { Router } from 'express';
import { h, str, bad, forbidden, notFound, int } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { conversationAccess, requireCan } from '../lib/perms.js';
import { serializeMessage, broadcast, URL_RE } from '../lib/messaging.js';
import { config } from '../config.js';
import { logModeration } from './conversations.js';

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji}|‍|️){1,16}$/u;

export default function messageRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  function load(req) {
    const m = db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) throw notFound('Message');
    const a = conversationAccess(db, req.user.id, m.conversation_id);
    if (!a.can.view) throw notFound('Message');
    if (a.member?.cleared_at && m.created_at <= a.member.cleared_at) throw notFound('Message');
    return { m, a };
  }

  const emit = (a, m, type = 'message:update') =>
    broadcast(ctx, a.conv, { type, message: serializeMessage(ctx, db.get('SELECT * FROM messages WHERE id = ?', m.id)) });

  r.get('/:id', h((req, res) => {
    const { m } = load(req);
    res.json({ message: serializeMessage(ctx, m, req.user.id) });
  }));

  r.patch('/:id', h((req, res) => {
    const { m, a } = load(req);
    if (m.sender_id !== req.user.id) throw forbidden('You can only edit your own messages.');
    if (m.deleted_at || m.kind === 'system' || m.kind === 'poll' || m.kind === 'sticker') throw bad('This message cannot be edited.');
    const body = str(req.body.body, 'Message', { max: config.maxMessageLength });
    if (!body && m.kind === 'text') throw bad('Message is empty.');
    const links = [...new Set(body.match(URL_RE) || [])].slice(0, 20);
    const data = JSON.parse(m.data || '{}');
    if (links.length) data.links = links;
    else delete data.links;
    db.run('UPDATE messages SET body = ?, edited_at = ?, has_links = ?, data = ? WHERE id = ?',
      body, Date.now(), links.length ? 1 : 0, Object.keys(data).length ? JSON.stringify(data) : null, m.id);
    emit(a, m);
    res.json({ message: serializeMessage(ctx, db.get('SELECT * FROM messages WHERE id = ?', m.id), req.user.id) });
  }));

  r.delete('/:id', h((req, res) => {
    const { m, a } = load(req);
    const own = m.sender_id === req.user.id;
    if (!own) requireCan(a, 'deleteAny', 'You can only delete your own messages.');
    if (m.deleted_at) return res.json({ ok: true });
    db.run('UPDATE messages SET deleted_at = ?, deleted_by = ?, body = ?, data = NULL, pinned_at = NULL WHERE id = ?', Date.now(), req.user.id, '', m.id);
    db.run('DELETE FROM reactions WHERE message_id = ?', m.id);
    if (!own) logModeration(ctx, req.user.id, a.conv, 'message', m.id, 'delete_message', req.body?.reason);
    emit(a, m, 'message:delete');
    res.json({ ok: true });
  }));

  r.put('/:id/reactions/:emoji', h((req, res) => {
    limiter.check(`react:${req.user.id}`, 60, 10_000);
    const { m, a } = load(req);
    requireCan(a, 'react', 'You cannot react here.');
    const emoji = decodeURIComponent(req.params.emoji);
    if (!EMOJI_RE.test(emoji)) throw bad('Unsupported reaction.');
    if (m.deleted_at) throw bad('Message was deleted.');
    const distinct = Number(db.value('SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = ?', m.id));
    if (distinct >= 20 && !db.get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?', m.id, emoji)) throw bad('Too many different reactions.');
    db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)', m.id, req.user.id, emoji, Date.now());
    emit(a, m);
    res.json({ ok: true });
  }));

  r.delete('/:id/reactions/:emoji', h((req, res) => {
    const { m, a } = load(req);
    db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, decodeURIComponent(req.params.emoji));
    emit(a, m);
    res.json({ ok: true });
  }));

  r.post('/:id/pin', h((req, res) => {
    const { m, a } = load(req);
    requireCan(a, 'pin', 'You cannot pin messages here.');
    if (m.deleted_at) throw bad('Message was deleted.');
    const pin = req.body.pinned !== false;
    db.run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', pin ? Date.now() : null, pin ? req.user.id : null, m.id);
    emit(a, m);
    res.json({ ok: true });
  }));

  r.post('/:id/vote', h((req, res) => {
    const { m, a } = load(req);
    if (m.kind !== 'poll' || m.deleted_at) throw bad('Not a poll.');
    if (!a.can.react && !a.can.send) throw forbidden('You cannot vote here.');
    const data = JSON.parse(m.data || '{}');
    if (req.body.option === null) {
      db.run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', m.id, req.user.id);
    } else {
      const option = int(req.body.option, 'Option', { min: 0, max: (data.poll?.options.length || 1) - 1 });
      db.run('INSERT OR REPLACE INTO poll_votes (message_id, user_id, option_index) VALUES (?,?,?)', m.id, req.user.id, option);
    }
    emit(a, m);
    res.json({ message: serializeMessage(ctx, m, req.user.id) });
  }));

  return r;
}
