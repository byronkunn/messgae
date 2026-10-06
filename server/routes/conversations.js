import { Router } from 'express';
import { h, str, bad, forbidden, notFound, int, bool, oneOf, parseJson, HttpError } from '../lib/http.js';
import { requireUser, notRestricted } from '../lib/auth.js';
import { conversationAccess, requireCan, GROUP_ROLE_RANK, parseSettings, isBlockedEitherWay } from '../lib/perms.js';
import { canMessage, miniUser, publicProfile, privacyOf, notify, audienceAllows } from '../lib/users.js';
import {
  sendMessage, serializeMessages, serializeMessage, lastMessagePreview, unreadCount, broadcast, systemMessage,
  receiptsVisible, fileSummary,
} from '../lib/messaging.js';
import { newId, randomBase32 } from '../lib/crypto.js';
import { planOf } from './me.js';

const GROUP_DEFAULTS = { membersCanSend: true, membersCanSendMedia: true, membersCanInvite: true, membersCanPin: false, membersCanMentionAll: false };
const GROUP_SETTINGS = Object.keys(GROUP_DEFAULTS);
export const EXPLORE_TOPICS = ['gaming', 'technology', 'cars', 'anime', 'art', 'music', 'programming', 'sports', 'entertainment', 'education', 'science', 'other'];

export function conversationSummary(ctx, conv, userId, member) {
  const { db } = ctx;
  const out = {
    id: conv.id,
    type: conv.type,
    name: conv.name,
    description: conv.description,
    avatarFileId: conv.avatar_file_id,
    lastMessageAt: conv.last_message_at || conv.created_at,
    createdAt: conv.created_at,
    muted: !!member?.muted,
    unread: unreadCount(ctx, conv, member, userId),
    lastMessage: lastMessagePreview(ctx, conv.id, member),
  };
  if (conv.type === 'dm') {
    const other = db.get(
      `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.user_id != ?`,
      conv.id, userId,
    );
    const me = db.get('SELECT * FROM users WHERE id = ?', userId);
    out.otherUser = other ? publicProfile(ctx, other, userId) : null;
    if (out.otherUser?.muted) out.muted = true;
    out.name = other?.display_name || 'Deleted user';
    out.avatarFileId = other?.avatar_file_id || null;
    if (other && member && receiptsVisible(me, other)) {
      out.otherLastReadAt = db.value('SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, other.id);
    }
  } else if (conv.type === 'group') {
    out.memberCount = Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', conv.id));
    out.visibility = conv.visibility;
  } else if (conv.type === 'channel') {
    out.spaceId = conv.space_id;
    out.channelType = conv.channel_type;
    out.isPrivate = !!conv.is_private;
  }
  return out;
}

export function conversationDetail(ctx, access, userId) {
  const { conv, member, can } = access;
  const s = conversationSummary(ctx, conv, userId, member);
  return {
    ...s,
    settings: conv.type === 'group' ? { ...GROUP_DEFAULTS, ...parseSettings(conv.settings) } : undefined,
    slowModeSeconds: conv.slow_mode_seconds,
    locked: !!conv.locked,
    topic: conv.topic,
    language: conv.language,
    discoverable: !!conv.discoverable,
    joinMode: conv.join_mode,
    myRole: member?.role ?? null,
    isMember: conv.type === 'channel' ? !!access.space && can.view : !!member,
    preview: !!access.preview,
    blocked: !!access.blocked,
    can,
    pinnedCount: Number(ctx.db.value('SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL', conv.id)),
    categoryId: conv.category_id,
  };
}

function memberView(ctx, row, viewerId) {
  return {
    user: miniUser(row),
    role: row.role,
    joinedAt: row.joined_at,
    timeoutUntil: row.timeout_until && row.timeout_until > Date.now() ? row.timeout_until : null,
    online: audienceAllows(ctx.db, privacyOf(row).onlineStatus, row, viewerId) ? ctx.hub.isOnline(row.id) : undefined,
  };
}

export function addGroupMember(ctx, conv, userId, role = 'member') {
  ctx.db.run(
    'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?,?,?,?,?)',
    conv.id, userId, role, Date.now(), Date.now(),
  );
  ctx.db.run("DELETE FROM join_requests WHERE target_type = 'group' AND target_id = ? AND user_id = ?", conv.id, userId);
}

export default function conversationRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  const access = (req, opts) => conversationAccess(db, req.user.id, req.params.id, opts);
  const memberOf = (convId, userId) => db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', convId, userId);

  // ---- List & create --------------------------------------------------------------

  r.get('/', h((req, res) => {
    const rows = db.all(
      `SELECT c.*, m.muted, m.hidden, m.cleared_at, m.last_read_at, m.joined_at, m.role, m.user_id
       FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ?
       WHERE c.type IN ('dm','group') AND c.removed_at IS NULL AND m.hidden = 0
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 500`,
      req.user.id,
    );
    const items = rows
      .filter((c) => c.type === 'group' || c.last_message_at || c.created_by === req.user.id)
      .map((c) => conversationSummary(ctx, c, req.user.id, c));
    res.json({ conversations: items });
  }));

  r.post('/dm', h((req, res) => {
    limiter.check(`dm:${req.user.id}`, 60, 60_000);
    const other = db.get("SELECT * FROM users WHERE id = ? AND state != 'banned'", req.body.userId);
    if (!other) throw notFound('User');
    if (other.id === req.user.id) throw bad('You cannot message yourself.');
    const key = [req.user.id, other.id].sort().join(':');
    let conv = db.get('SELECT * FROM conversations WHERE dm_key = ?', key);
    if (!conv) {
      if (isBlockedEitherWay(db, req.user.id, other.id)) throw forbidden('You cannot message this user.');
      if (!canMessage(db, req.user, other)) throw forbidden(`${other.display_name} isn't accepting messages from you.`, 'privacy');
      if (req.user.state === 'restricted' && !db.get('SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?', other.id, req.user.id)) {
        notRestricted(req);
      }
      const id = newId('cnv');
      const t = Date.now();
      db.tx(() => {
        db.run('INSERT INTO conversations (id, type, dm_key, created_by, created_at) VALUES (?,?,?,?,?)', id, 'dm', key, req.user.id, t);
        db.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)', id, req.user.id, t, t);
        db.run('INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?,?,?,?)', id, other.id, t, t);
      });
      conv = db.get('SELECT * FROM conversations WHERE id = ?', id);
    } else {
      db.run('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ? AND user_id = ?', conv.id, req.user.id);
    }
    const a = conversationAccess(db, req.user.id, conv.id);
    res.json({ conversation: conversationDetail(ctx, a, req.user.id) });
  }));

  r.post('/groups', h((req, res) => {
    notRestricted(req);
    limiter.check(`group:${req.user.id}`, 20, 60 * 60_000);
    const name = str(req.body.name, 'Group name', { min: 1, max: 80 });
    const description = str(req.body.description, 'Description', { max: 500 });
    const memberIds = Array.isArray(req.body.memberIds) ? [...new Set(req.body.memberIds)].filter((id) => id !== req.user.id) : [];
    const limit = planOf(req.user).groupMembers;
    if (memberIds.length + 1 > limit) throw bad(`Groups on your plan can have up to ${limit} members.`);
    const members = memberIds.map((id) => {
      const u = db.get("SELECT * FROM users WHERE id = ? AND state != 'banned'", id);
      if (!u) throw bad('One of the selected users was not found.');
      if (isBlockedEitherWay(db, req.user.id, u.id)) throw forbidden(`You cannot add ${u.display_name}.`);
      const level = privacyOf(u).whoCanAddToGroups;
      if (!audienceAllows(db, level, u, req.user.id)) throw forbidden(`${u.display_name} doesn't allow being added to groups by you. Send an invite link instead.`, 'privacy');
      return u;
    });
    const id = newId('cnv');
    const t = Date.now();
    db.tx(() => {
      db.run(
        `INSERT INTO conversations (id, type, name, description, created_by, created_at, visibility, discoverable, join_mode, topic, language)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, 'group', name, description, req.user.id, t,
        oneOf(req.body.visibility, 'Visibility', ['public', 'private'], 'private'),
        bool(req.body.discoverable) ? 1 : 0,
        oneOf(req.body.joinMode, 'Join mode', ['open', 'approval', 'invite'], 'invite'),
        oneOf(req.body.topic || '', 'Topic', ['', ...EXPLORE_TOPICS], ''),
        str(req.body.language || 'en', 'Language', { max: 8 }),
      );
      db.run('INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?,?,?,?,?)', id, req.user.id, 'owner', t, t);
      for (const u of members) {
        db.run('INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?,?,?,?,?)', id, u.id, 'member', t, 0);
      }
    });
    const conv = db.get('SELECT * FROM conversations WHERE id = ?', id);
    systemMessage(ctx, conv, { event: 'group_created', actor: miniUser(req.user), name }, req.user.id);
    for (const u of members) notify(ctx, u.id, 'group_added', { conversationId: id, conversationName: name, from: miniUser(req.user) });
    res.status(201).json({ conversation: conversationDetail(ctx, conversationAccess(db, req.user.id, id), req.user.id) });
  }));

  // ---- Detail & settings ------------------------------------------------------------

  r.get('/:id', h((req, res) => {
    const a = access(req);
    res.json({ conversation: conversationDetail(ctx, a, req.user.id) });
  }));

  r.patch('/:id', h((req, res) => {
    const a = access(req);
    const { conv } = a;
    if (conv.type === 'dm') throw bad('Direct messages have no shared settings.');
    const b = req.body || {};
    const updates = {};
    const needManage = ['name', 'description', 'avatarFileId', 'settings', 'visibility', 'discoverable', 'joinMode', 'topic', 'language'];
    if (needManage.some((k) => b[k] !== undefined)) requireCan(a, 'manageChannel', 'Only admins can change these settings.');
    if (['slowModeSeconds', 'locked'].some((k) => b[k] !== undefined)) requireCan(a, 'moderate', 'Only moderators can change slow mode or lock.');
    if (b.name !== undefined) updates.name = str(b.name, 'Name', { min: 1, max: 80 });
    if (b.description !== undefined) updates.description = str(b.description, 'Description', { max: 1000 });
    if (b.avatarFileId !== undefined) {
      if (b.avatarFileId) {
        const f = db.get('SELECT * FROM files WHERE id = ? AND owner_id = ?', b.avatarFileId, req.user.id);
        if (!f || f.category !== 'image') throw bad('Avatar must be one of your images.');
      }
      updates.avatar_file_id = b.avatarFileId || null;
    }
    if (conv.type === 'group') {
      if (b.settings !== undefined) {
        const current = parseSettings(conv.settings);
        for (const k of GROUP_SETTINGS) if (b.settings[k] !== undefined) current[k] = !!b.settings[k];
        updates.settings = JSON.stringify(current);
      }
      if (b.visibility !== undefined) updates.visibility = oneOf(b.visibility, 'Visibility', ['public', 'private']);
      if (b.discoverable !== undefined) updates.discoverable = bool(b.discoverable) ? 1 : 0;
      if (b.joinMode !== undefined) updates.join_mode = oneOf(b.joinMode, 'Join mode', ['open', 'approval', 'invite']);
      if (b.topic !== undefined) updates.topic = oneOf(b.topic, 'Topic', ['', ...EXPLORE_TOPICS]);
      if (b.language !== undefined) updates.language = str(b.language, 'Language', { max: 8 });
    }
    if (b.slowModeSeconds !== undefined) updates.slow_mode_seconds = int(b.slowModeSeconds, 'Slow mode', { min: 0, max: 21600 });
    if (b.locked !== undefined) updates.locked = bool(b.locked) ? 1 : 0;
    const cols = Object.keys(updates);
    if (cols.length) db.run(`UPDATE conversations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(updates), conv.id);
    const fresh = conversationAccess(db, req.user.id, conv.id);
    broadcast(ctx, fresh.conv, { type: 'conversation:update' });
    if (updates.slow_mode_seconds !== undefined || updates.locked !== undefined) {
      db.run(
        'INSERT INTO moderation_actions (id, actor_id, scope, target_type, target_id, action, created_at) VALUES (?,?,?,?,?,?,?)',
        newId('mod'), req.user.id, conv.space_id ? `space:${conv.space_id}` : `group:${conv.id}`, 'conversation', conv.id,
        updates.locked !== undefined ? (updates.locked ? 'lock' : 'unlock') : `slow_mode:${updates.slow_mode_seconds}`, Date.now(),
      );
    }
    res.json({ conversation: conversationDetail(ctx, fresh, req.user.id) });
  }));

  r.patch('/:id/me', h((req, res) => {
    const a = access(req);
    if (!a.member) throw bad('Not a member.');
    if (req.body.muted !== undefined) db.run('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?', bool(req.body.muted) ? 1 : 0, a.conv.id, req.user.id);
    res.json({ ok: true });
  }));

  r.post('/:id/read', h((req, res) => {
    const a = access(req);
    if (!a.member) return res.json({ ok: true });
    const at = Math.min(Number(req.body.at) || Date.now(), Date.now());
    db.run('UPDATE conversation_members SET last_read_at = MAX(COALESCE(last_read_at, 0), ?) WHERE conversation_id = ? AND user_id = ?', at, a.conv.id, req.user.id);
    if (a.conv.type === 'dm' && privacyOf(req.user).readReceipts && a.otherUserId) {
      const other = db.get('SELECT * FROM users WHERE id = ?', a.otherUserId);
      if (other && privacyOf(other).readReceipts) ctx.hub.toUser(other.id, { type: 'read', conversationId: a.conv.id, userId: req.user.id, at });
    }
    ctx.hub.toUser(req.user.id, { type: 'read:self', conversationId: a.conv.id, at });
    res.json({ ok: true });
  }));

  r.post('/:id/clear', h((req, res) => {
    const a = access(req);
    if (!a.member) throw bad('Not a member.');
    db.run('UPDATE conversation_members SET cleared_at = ?, last_read_at = ? WHERE conversation_id = ? AND user_id = ?', Date.now(), Date.now(), a.conv.id, req.user.id);
    res.json({ ok: true });
  }));

  /** DMs: removes the conversation from your list and clears your history. Groups: owner deletes for everyone. */
  r.delete('/:id', h((req, res) => {
    const a = access(req);
    const { conv } = a;
    if (conv.type === 'dm') {
      db.run('UPDATE conversation_members SET hidden = 1, cleared_at = ? WHERE conversation_id = ? AND user_id = ?', Date.now(), conv.id, req.user.id);
    } else if (conv.type === 'group') {
      if (a.member?.role !== 'owner') throw forbidden('Only the owner can delete this group.');
      db.run('UPDATE conversations SET removed_at = ? WHERE id = ?', Date.now(), conv.id);
      broadcast(ctx, conv, { type: 'conversation:removed' });
    } else {
      throw bad('Delete channels from Space settings.');
    }
    res.json({ ok: true });
  }));

  // ---- Messages -----------------------------------------------------------------

  r.get('/:id/messages', h((req, res) => {
    const a = access(req);
    if (!a.can.view && !a.preview) throw notFound('Conversation');
    const limit = int(req.query.limit, 'limit', { min: 1, max: 100, fallback: 50 });
    const params = [a.conv.id];
    let where = 'conversation_id = ?';
    if (req.query.threadId) {
      where += ' AND thread_id = ?';
      params.push(String(req.query.threadId));
    } else if (a.conv.channel_type === 'forum') {
      where += ' AND thread_id IS NULL';
    } else {
      where += ' AND thread_id IS NULL';
    }
    if (a.member?.cleared_at) {
      where += ' AND created_at > ?';
      params.push(a.member.cleared_at);
    }
    let rows;
    if (req.query.after) {
      const [t, id] = String(req.query.after).split('~');
      rows = db.all(
        `SELECT * FROM messages WHERE ${where} AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?`,
        ...params, Number(t), Number(t), id || '', limit,
      );
    } else if (req.query.around) {
      const target = db.get(`SELECT * FROM messages WHERE id = ? AND conversation_id = ?`, String(req.query.around), a.conv.id);
      if (!target) throw notFound('Message');
      const half = Math.floor(limit / 2);
      const before = db.all(
        `SELECT * FROM messages WHERE ${where} AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...params, target.created_at, target.created_at, target.id, half,
      ).reverse();
      const after = db.all(
        `SELECT * FROM messages WHERE ${where} AND (created_at > ? OR (created_at = ? AND id >= ?)) ORDER BY created_at ASC, id ASC LIMIT ?`,
        ...params, target.created_at, target.created_at, target.id, limit - half,
      );
      rows = [...before, ...after];
    } else {
      let seek = '';
      const seekParams = [];
      if (req.query.before) {
        const [t, id] = String(req.query.before).split('~');
        seek = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
        seekParams.push(Number(t), Number(t), id || '');
      }
      rows = db.all(
        `SELECT * FROM messages WHERE ${where}${seek} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...params, ...seekParams, limit,
      ).reverse();
    }
    const first = rows[0];
    res.json({
      messages: serializeMessages(ctx, rows, req.user.id),
      beforeCursor: first && rows.length >= (req.query.around ? 1 : limit) ? `${first.created_at}~${first.id}` : null,
      hasMore: rows.length >= limit,
    });
  }));

  r.post('/:id/messages', h((req, res) => {
    limiter.check(`send:${req.user.id}`, 30, 10_000);
    const a = access(req);
    const message = sendMessage(ctx, req.user, a, req.body || {});
    res.status(201).json({ message });
  }));

  r.get('/:id/search', h((req, res) => {
    const a = access(req);
    if (!a.can.view) throw notFound('Conversation');
    const q = String(req.query.q || '').trim();
    const where = ['m.conversation_id = ?', 'm.deleted_at IS NULL'];
    const params = [a.conv.id];
    if (a.member?.cleared_at) {
      where.push('m.created_at > ?');
      params.push(a.member.cleared_at);
    }
    if (q) {
      where.push(`(m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM message_attachments x JOIN files f ON f.id = x.file_id WHERE x.message_id = m.id AND f.filename LIKE ? ESCAPE '\\'))`);
      const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    if (req.query.from) {
      where.push('m.sender_id = ?');
      params.push(String(req.query.from));
    }
    if (!q && !req.query.from) return res.json({ messages: [] });
    const rows = db.all(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 50`, ...params);
    res.json({ messages: serializeMessages(ctx, rows, req.user.id) });
  }));

  /** Media / Files / Links tabs. */
  r.get('/:id/gallery', h((req, res) => {
    const a = access(req);
    if (!a.can.view) throw notFound('Conversation');
    const kind = oneOf(req.query.kind, 'kind', ['media', 'files', 'links', 'voice'], 'media');
    const cleared = a.member?.cleared_at || 0;
    if (kind === 'links') {
      const rows = db.all(
        `SELECT * FROM messages WHERE conversation_id = ? AND has_links = 1 AND deleted_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 200`,
        a.conv.id, cleared,
      );
      const links = rows.flatMap((m) => (parseJson(m.data, {}).links || []).map((url) => ({ url, messageId: m.id, senderId: m.sender_id, createdAt: m.created_at })));
      return res.json({ links });
    }
    const cats = kind === 'media' ? "('image','video')" : kind === 'voice' ? "('audio')" : "('document','archive','other','audio')";
    const rows = db.all(
      `SELECT f.*, m.id AS message_id, m.created_at AS sent_at, m.sender_id FROM messages m
       JOIN message_attachments x ON x.message_id = m.id JOIN files f ON f.id = x.file_id
       WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.created_at > ? AND f.category IN ${cats}
       ORDER BY m.created_at DESC LIMIT 300`,
      a.conv.id, cleared,
    );
    res.json({ items: rows.map((f) => ({ ...fileSummary(f), messageId: f.message_id, sentAt: f.sent_at, senderId: f.sender_id })) });
  }));

  r.get('/:id/pins', h((req, res) => {
    const a = access(req);
    if (!a.can.view) throw notFound('Conversation');
    const rows = db.all('SELECT * FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 100', a.conv.id);
    res.json({ messages: serializeMessages(ctx, rows, req.user.id) });
  }));

  // ---- Forum threads ----------------------------------------------------------------

  r.get('/:id/threads', h((req, res) => {
    const a = access(req);
    if (!a.can.view && !a.preview) throw notFound('Conversation');
    const rows = db.all(
      `SELECT t.*, u.username, u.display_name FROM threads t JOIN users u ON u.id = t.created_by
       WHERE t.channel_id = ? ORDER BY t.pinned DESC, COALESCE(t.last_message_at, t.created_at) DESC LIMIT 200`, a.conv.id,
    );
    res.json({
      threads: rows.map((t) => ({
        id: t.id, title: t.title, createdAt: t.created_at, lastMessageAt: t.last_message_at, messageCount: t.message_count,
        locked: !!t.locked, pinned: !!t.pinned, creator: { id: t.created_by, username: t.username, displayName: t.display_name },
      })),
    });
  }));

  r.post('/:id/threads', h((req, res) => {
    limiter.check(`thread:${req.user.id}`, 10, 60_000);
    const a = access(req);
    if (a.conv.channel_type !== 'forum') throw bad('Topics are only available in forum channels.');
    requireCan(a, 'createThreads', 'You cannot start topics here.');
    notRestricted(req);
    const title = str(req.body.title, 'Title', { min: 1, max: 140 });
    const id = newId('thr');
    db.run('INSERT INTO threads (id, channel_id, title, created_by, created_at) VALUES (?,?,?,?,?)', id, a.conv.id, title, req.user.id, Date.now());
    let message;
    try {
      message = sendMessage(ctx, req.user, a, { ...req.body, threadId: id, _threadStarter: true });
    } catch (err) {
      db.run('DELETE FROM threads WHERE id = ?', id);
      throw err;
    }
    broadcast(ctx, a.conv, { type: 'thread:new', threadId: id });
    res.status(201).json({ thread: { id, title }, message });
  }));

  r.patch('/:id/threads/:threadId', h((req, res) => {
    const a = access(req);
    const t = db.get('SELECT * FROM threads WHERE id = ? AND channel_id = ?', req.params.threadId, a.conv.id);
    if (!t) throw notFound('Topic');
    if (req.body.locked !== undefined || req.body.pinned !== undefined) requireCan(a, 'manageMessages', 'Only moderators can lock or pin topics.');
    if (req.body.title !== undefined && t.created_by !== req.user.id && !a.can.manageMessages) throw forbidden();
    if (req.body.title !== undefined) db.run('UPDATE threads SET title = ? WHERE id = ?', str(req.body.title, 'Title', { min: 1, max: 140 }), t.id);
    if (req.body.locked !== undefined) db.run('UPDATE threads SET locked = ? WHERE id = ?', bool(req.body.locked) ? 1 : 0, t.id);
    if (req.body.pinned !== undefined) db.run('UPDATE threads SET pinned = ? WHERE id = ?', bool(req.body.pinned) ? 1 : 0, t.id);
    broadcast(ctx, a.conv, { type: 'thread:update', threadId: t.id });
    res.json({ ok: true });
  }));

  r.delete('/:id/threads/:threadId', h((req, res) => {
    const a = access(req);
    const t = db.get('SELECT * FROM threads WHERE id = ? AND channel_id = ?', req.params.threadId, a.conv.id);
    if (!t) throw notFound('Topic');
    if (t.created_by !== req.user.id && !a.can.deleteAny) throw forbidden();
    db.run('DELETE FROM threads WHERE id = ?', t.id);
    broadcast(ctx, a.conv, { type: 'thread:update', threadId: t.id });
    res.json({ ok: true });
  }));

  // ---- Group membership ---------------------------------------------------------------

  const requireGroup = (a) => {
    if (a.conv.type !== 'group') throw bad('Only available for groups.');
  };

  r.get('/:id/members', h((req, res) => {
    const a = access(req);
    if (a.conv.type === 'channel') throw bad('Use the Space member list.');
    if (!a.member && !a.preview) throw notFound('Conversation');
    const q = String(req.query.q || '').trim();
    const rows = db.all(
      `SELECT u.*, m.role, m.joined_at, m.timeout_until FROM conversation_members m JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ${q ? "AND (u.username LIKE ? OR u.display_name LIKE ?)" : ''}
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.display_name COLLATE NOCASE
       LIMIT 500`,
      a.conv.id, ...(q ? [`%${q}%`, `%${q}%`] : []),
    );
    res.json({ members: rows.map((m) => memberView(ctx, m, req.user.id)) });
  }));

  r.post('/:id/members', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'createInvites', 'You cannot add members to this group.');
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.slice(0, 50) : [];
    const limit = planOf(db.get('SELECT * FROM users WHERE id = ?', a.conv.created_by) || req.user).groupMembers;
    const count = Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', a.conv.id));
    if (count + ids.length > limit) throw bad(`This group is limited to ${limit} members.`);
    const added = [];
    for (const id of ids) {
      const u = db.get("SELECT * FROM users WHERE id = ? AND state != 'banned'", id);
      if (!u || memberOf(a.conv.id, id)) continue;
      if (db.get('SELECT 1 FROM conversation_bans WHERE conversation_id = ? AND user_id = ?', a.conv.id, id)) throw bad(`${u.display_name} is banned from this group.`);
      if (isBlockedEitherWay(db, req.user.id, u.id) || !audienceAllows(db, privacyOf(u).whoCanAddToGroups, u, req.user.id)) {
        throw forbidden(`${u.display_name} doesn't allow being added to groups by you. Send an invite link instead.`, 'privacy');
      }
      addGroupMember(ctx, a.conv, u.id);
      notify(ctx, u.id, 'group_added', { conversationId: a.conv.id, conversationName: a.conv.name, from: miniUser(req.user) });
      added.push(miniUser(u));
    }
    if (added.length) systemMessage(ctx, a.conv, { event: 'members_added', actor: miniUser(req.user), users: added }, req.user.id);
    res.json({ added });
  }));

  r.patch('/:id/members/:userId', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    const target = memberOf(a.conv.id, req.params.userId);
    if (!target) throw notFound('Member');
    const role = oneOf(req.body.role, 'Role', ['member', 'moderator', 'admin', 'owner']);
    const myRank = GROUP_ROLE_RANK[a.member?.role] ?? -1;
    if (role === 'owner') {
      if (a.member.role !== 'owner') throw forbidden('Only the owner can transfer ownership.');
      db.tx(() => {
        db.run("UPDATE conversation_members SET role = 'admin' WHERE conversation_id = ? AND user_id = ?", a.conv.id, req.user.id);
        db.run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", a.conv.id, target.user_id);
      });
    } else {
      if (myRank < 2) throw forbidden('Only admins can change roles.');
      if (GROUP_ROLE_RANK[target.role] >= myRank || GROUP_ROLE_RANK[role] >= myRank) {
        if (a.member.role !== 'owner') throw forbidden('You can only manage roles below your own.');
      }
      if (target.role === 'owner') throw forbidden('Transfer ownership first.');
      db.run('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?', role, a.conv.id, target.user_id);
    }
    const u = db.get('SELECT * FROM users WHERE id = ?', target.user_id);
    systemMessage(ctx, a.conv, { event: 'role_changed', actor: miniUser(req.user), user: miniUser(u), role }, req.user.id);
    res.json({ ok: true });
  }));

  function outranks(a, target) {
    return (GROUP_ROLE_RANK[a.member?.role] ?? -1) > (GROUP_ROLE_RANK[target.role] ?? 0);
  }

  r.delete('/:id/members/:userId', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    const target = memberOf(a.conv.id, req.params.userId);
    if (!target) throw notFound('Member');
    const self = target.user_id === req.user.id;
    if (!self) {
      requireCan(a, 'manageMembers', 'You cannot remove members.');
      if (!outranks(a, target)) throw forbidden('You can only remove members below your role.');
    }
    db.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', a.conv.id, target.user_id);
    if (self && target.role === 'owner') {
      const next = db.get(
        `SELECT * FROM conversation_members WHERE conversation_id = ?
         ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, joined_at LIMIT 1`, a.conv.id,
      );
      if (next) db.run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", a.conv.id, next.user_id);
      else db.run('UPDATE conversations SET removed_at = ? WHERE id = ?', Date.now(), a.conv.id);
    }
    const u = db.get('SELECT * FROM users WHERE id = ?', target.user_id);
    systemMessage(ctx, a.conv, { event: self ? 'member_left' : 'member_removed', actor: miniUser(req.user), user: miniUser(u) }, req.user.id);
    ctx.hub.toUser(target.user_id, { type: 'conversation:removed', conversationId: a.conv.id });
    if (!self) logModeration(ctx, req.user.id, a.conv, 'user', target.user_id, 'kick', req.body?.reason);
    res.json({ ok: true });
  }));

  r.post('/:id/members/:userId/timeout', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'manageMembers');
    const target = memberOf(a.conv.id, req.params.userId);
    if (!target) throw notFound('Member');
    if (!outranks(a, target)) throw forbidden('You can only time out members below your role.');
    const minutes = int(req.body.minutes, 'Minutes', { min: 0, max: 60 * 24 * 28 });
    const until = minutes ? Date.now() + minutes * 60_000 : null;
    db.run('UPDATE conversation_members SET timeout_until = ? WHERE conversation_id = ? AND user_id = ?', until, a.conv.id, target.user_id);
    logModeration(ctx, req.user.id, a.conv, 'user', target.user_id, minutes ? `timeout:${minutes}m` : 'timeout_cleared', req.body.reason, until);
    res.json({ ok: true, until });
  }));

  r.get('/:id/bans', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'ban');
    const rows = db.all('SELECT b.*, u.username, u.display_name FROM conversation_bans b JOIN users u ON u.id = b.user_id WHERE b.conversation_id = ? ORDER BY b.created_at DESC', a.conv.id);
    res.json({ bans: rows.map((b) => ({ user: { id: b.user_id, username: b.username, displayName: b.display_name }, reason: b.reason, createdAt: b.created_at })) });
  }));

  r.post('/:id/bans', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'ban');
    const userId = String(req.body.userId || '');
    const target = memberOf(a.conv.id, userId);
    if (target && !outranks(a, target)) throw forbidden('You can only ban members below your role.');
    if (userId === req.user.id) throw bad('You cannot ban yourself.');
    const reason = str(req.body.reason, 'Reason', { max: 500 });
    db.run('INSERT OR REPLACE INTO conversation_bans (conversation_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)', a.conv.id, userId, reason, req.user.id, Date.now());
    db.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', a.conv.id, userId);
    ctx.hub.toUser(userId, { type: 'conversation:removed', conversationId: a.conv.id });
    logModeration(ctx, req.user.id, a.conv, 'user', userId, 'ban', reason);
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (u) systemMessage(ctx, a.conv, { event: 'member_banned', actor: miniUser(req.user), user: miniUser(u) }, req.user.id);
    res.json({ ok: true });
  }));

  r.delete('/:id/bans/:userId', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'ban');
    db.run('DELETE FROM conversation_bans WHERE conversation_id = ? AND user_id = ?', a.conv.id, req.params.userId);
    logModeration(ctx, req.user.id, a.conv, 'user', req.params.userId, 'unban');
    res.json({ ok: true });
  }));

  /** Join a public group directly (open) or request to join (approval). */
  r.post('/:id/join', h((req, res) => {
    notRestricted(req);
    const a = access(req);
    requireGroup(a);
    if (a.member) return res.json({ status: 'joined' });
    if (!a.preview) throw notFound('Conversation');
    const count = Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', a.conv.id));
    const owner = db.get("SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.role = 'owner'", a.conv.id);
    if (count >= planOf(owner || {}).groupMembers) throw bad('This group is full.');
    if (a.conv.join_mode === 'open') {
      addGroupMember(ctx, a.conv, req.user.id);
      systemMessage(ctx, a.conv, { event: 'member_joined', user: miniUser(req.user) }, req.user.id);
      return res.json({ status: 'joined' });
    }
    if (a.conv.join_mode === 'approval') {
      db.run("INSERT OR IGNORE INTO join_requests (target_type, target_id, user_id, message, created_at) VALUES ('group',?,?,?,?)",
        a.conv.id, req.user.id, str(req.body.message, 'Message', { max: 300 }), Date.now());
      const admins = db.all("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND role IN ('owner','admin')", a.conv.id);
      for (const ad of admins) notify(ctx, ad.user_id, 'join_request', { conversationId: a.conv.id, conversationName: a.conv.name, from: miniUser(req.user) });
      return res.json({ status: 'requested' });
    }
    throw forbidden('This group is invite-only.');
  }));

  r.get('/:id/requests', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'manageMembers');
    const rows = db.all("SELECT j.*, u.username, u.display_name, u.avatar_file_id FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.target_type = 'group' AND j.target_id = ?", a.conv.id);
    res.json({ requests: rows.map((j) => ({ user: { id: j.user_id, username: j.username, displayName: j.display_name, avatarFileId: j.avatar_file_id }, message: j.message, createdAt: j.created_at })) });
  }));

  r.post('/:id/requests/:userId', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'manageMembers');
    const reqRow = db.get("SELECT * FROM join_requests WHERE target_type = 'group' AND target_id = ? AND user_id = ?", a.conv.id, req.params.userId);
    if (!reqRow) throw notFound('Request');
    if (bool(req.body.approve)) {
      addGroupMember(ctx, a.conv, reqRow.user_id);
      notify(ctx, reqRow.user_id, 'join_approved', { conversationId: a.conv.id, conversationName: a.conv.name });
      systemMessage(ctx, a.conv, { event: 'member_joined', user: miniUser(db.get('SELECT * FROM users WHERE id = ?', reqRow.user_id)) }, reqRow.user_id);
    } else {
      db.run("DELETE FROM join_requests WHERE target_type = 'group' AND target_id = ? AND user_id = ?", a.conv.id, reqRow.user_id);
    }
    res.json({ ok: true });
  }));

  // ---- Invite links -----------------------------------------------------------------

  r.get('/:id/invites', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'createInvites');
    const rows = db.all(
      `SELECT * FROM invites WHERE target_type = 'group' AND target_id = ? AND revoked_at IS NULL ${a.can.manageMembers ? '' : 'AND created_by = ?'} ORDER BY created_at DESC`,
      a.conv.id, ...(a.can.manageMembers ? [] : [req.user.id]),
    );
    res.json({ invites: rows.map(inviteView) });
  }));

  r.post('/:id/invites', h((req, res) => {
    const a = access(req);
    requireGroup(a);
    requireCan(a, 'createInvites', 'You cannot create invites here.');
    notRestricted(req);
    const invite = createInvite(db, 'group', a.conv.id, req.user.id, req.body);
    res.status(201).json({ invite: inviteView(invite) });
  }));

  return r;
}

export function createInvite(db, targetType, targetId, userId, body = {}, { allowVanity = false } = {}) {
  let code = randomBase32(10);
  if (body.vanityCode) {
    if (!allowVanity) throw new HttpError(402, 'plan_required', 'Vanity invite links are part of Space Pro.');
    code = str(body.vanityCode, 'Vanity code', { min: 3, max: 32, pattern: /^[A-Za-z0-9-]+$/ }).toUpperCase();
    const existing = db.get('SELECT revoked_at FROM invites WHERE code = ?', code);
    if (existing && !existing.revoked_at) throw bad('That invite link is already taken.');
    if (existing) db.run('DELETE FROM invites WHERE code = ?', code);
  }
  const hours = body.expiresInHours ? int(body.expiresInHours, 'Expiry', { min: 1, max: 24 * 365 }) : null;
  const maxUses = body.maxUses ? int(body.maxUses, 'Max uses', { min: 1, max: 100000 }) : null;
  db.run(
    'INSERT INTO invites (code, target_type, target_id, created_by, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
    code, targetType, targetId, userId, maxUses, hours ? Date.now() + hours * 3600_000 : null, Date.now(),
  );
  return db.get('SELECT * FROM invites WHERE code = ?', code);
}

export function inviteView(i) {
  return { code: i.code, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, createdAt: i.created_at, createdBy: i.created_by };
}

export function logModeration(ctx, actorId, conv, targetType, targetId, action, reason = null, expiresAt = null) {
  ctx.db.run(
    `INSERT INTO moderation_actions (id, actor_id, scope, target_type, target_id, action, reason, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId('mod'), actorId, conv.space_id ? `space:${conv.space_id}` : `group:${conv.id}`, targetType, targetId, action,
    reason || null, expiresAt, Date.now(),
  );
}

export { serializeMessage };
