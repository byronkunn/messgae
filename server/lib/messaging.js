import { newId } from './crypto.js';
import { bad, forbidden, HttpError, parseJson, str } from './http.js';
import { channelPerms, P } from './perms.js';
import { miniUser, notify, privacyOf } from './users.js';
import { config } from '../config.js';

export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi;
const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9_]{3,32})\b/g;
export const STICKER_RE = /^[a-z0-9_-]{1,32}$/;

export function fileSummary(f) {
  if (!f) return null;
  return {
    id: f.id,
    filename: f.filename,
    mime: f.mime,
    category: f.category,
    size: f.size,
    ownerId: f.owner_id,
    createdAt: f.created_at,
    passwordProtected: !!f.password_verifier,
    moderationStatus: f.moderation_status,
    available: f.moderation_status === 'ok' || f.moderation_status === 'restricted',
  };
}

function reactionSummary(db, messageId) {
  const rows = db.all('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at', messageId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, { emoji: r.emoji, count: 0, userIds: [] });
    const e = map.get(r.emoji);
    e.count++;
    if (e.userIds.length < 50) e.userIds.push(r.user_id);
  }
  return [...map.values()];
}

const userCache = (db) => {
  const cache = new Map();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, miniUser(db.get('SELECT * FROM users WHERE id = ?', id)));
    return cache.get(id);
  };
};

/** Serializes a message. `viewerId` null produces a viewer-neutral payload for broadcasts. */
export function serializeMessage(ctx, m, viewerId = null, getUser = userCache(ctx.db)) {
  const { db } = ctx;
  const deleted = !!m.deleted_at;
  const data = parseJson(m.data, {});
  const out = {
    id: m.id,
    conversationId: m.conversation_id,
    threadId: m.thread_id,
    sender: getUser(m.sender_id),
    kind: m.kind,
    body: deleted ? '' : m.body,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    removedByModerator: deleted && m.deleted_by && m.deleted_by !== m.sender_id,
    pinnedAt: m.pinned_at,
    reactions: deleted ? [] : reactionSummary(db, m.id),
    attachments: [],
  };
  if (!deleted) {
    out.attachments = db
      .all(
        `SELECT f.* FROM message_attachments a JOIN files f ON f.id = a.file_id WHERE a.message_id = ? ORDER BY a.position`,
        m.id,
      )
      .map(fileSummary);
    if (m.kind === 'sticker') out.sticker = data.sticker;
    if (m.kind === 'system') out.system = data.system;
    if (data.links) out.links = data.links;
    if (m.kind === 'poll' && data.poll) {
      const counts = data.poll.options.map(() => 0);
      for (const v of db.all('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE message_id = ? GROUP BY option_index', m.id)) {
        counts[v.option_index] = v.n;
      }
      out.poll = { question: data.poll.question, options: data.poll.options, votes: counts, total: counts.reduce((a, b) => a + b, 0) };
      if (viewerId) out.poll.myVote = db.get('SELECT option_index FROM poll_votes WHERE message_id = ? AND user_id = ?', m.id, viewerId)?.option_index ?? null;
    }
    if (data.mentions) out.mentions = data.mentions;
  }
  if (m.reply_to_id) {
    const parent = db.get('SELECT id, sender_id, body, kind, deleted_at FROM messages WHERE id = ?', m.reply_to_id);
    out.replyTo = parent
      ? {
          id: parent.id,
          sender: getUser(parent.sender_id),
          snippet: parent.deleted_at ? 'Message deleted' : parent.body ? parent.body.slice(0, 140) : `[${parent.kind}]`,
        }
      : { id: m.reply_to_id, snippet: 'Message unavailable' };
  }
  return out;
}

export function serializeMessages(ctx, rows, viewerId) {
  const getUser = userCache(ctx.db);
  return rows.map((m) => serializeMessage(ctx, m, viewerId, getUser));
}

/** Users who should receive live events for a conversation. */
export function recipientsOf(ctx, conv) {
  const { db, hub } = ctx;
  if (conv.type === 'channel') {
    const online = new Set(hub.onlineUserIds());
    if (!online.size) return [];
    const members = db.all('SELECT user_id FROM space_members WHERE space_id = ?', conv.space_id).map((r) => r.user_id);
    return members.filter((id) => online.has(id) && channelPerms(db, conv, id).perms & P.VIEW_CHANNEL);
  }
  return db.all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conv.id).map((r) => r.user_id);
}

export function broadcast(ctx, conv, event) {
  ctx.hub.toUsers(recipientsOf(ctx, conv), { ...event, conversationId: conv.id });
}

export function lastMessagePreview(ctx, convId, viewerMember) {
  const m = ctx.db.get(
    `SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS NULL
       AND created_at > COALESCE(?, 0) ORDER BY created_at DESC, id DESC LIMIT 1`,
    convId, viewerMember?.cleared_at ?? null,
  );
  if (!m) return null;
  const sender = ctx.db.get('SELECT display_name FROM users WHERE id = ?', m.sender_id);
  let text = m.deleted_at ? 'Message deleted' : m.body;
  if (!m.deleted_at && !text) {
    text = { media: '📷 Media', file: '📎 File', voice: '🎤 Voice message', sticker: 'Sticker', poll: '📊 Poll', system: 'Update' }[m.kind] || '';
  }
  return { id: m.id, text: text.slice(0, 120), senderId: m.sender_id, senderName: sender?.display_name, createdAt: m.created_at };
}

export function unreadCount(ctx, conv, member, userId) {
  if (!member) return 0;
  const since = Math.max(member.last_read_at ?? member.joined_at ?? 0, member.cleared_at ?? 0);
  return Number(ctx.db.value(
    `SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE conversation_id = ? AND created_at > ? AND sender_id IS NOT ?
       AND deleted_at IS NULL LIMIT 999)`,
    conv.id, since, userId,
  ));
}

export function systemMessage(ctx, conv, system, actorId = null) {
  const msg = {
    id: newId('msg'),
    created_at: Date.now(),
  };
  ctx.db.run(
    `INSERT INTO messages (id, conversation_id, sender_id, kind, body, data, created_at) VALUES (?,?,?,?,?,?,?)`,
    msg.id, conv.id, actorId, 'system', '', JSON.stringify({ system }), msg.created_at,
  );
  ctx.db.run('UPDATE conversations SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?', msg.created_at, conv.id);
  const row = ctx.db.get('SELECT * FROM messages WHERE id = ?', msg.id);
  broadcast(ctx, conv, { type: 'message:new', message: serializeMessage(ctx, row) });
  return row;
}

/**
 * Validates and stores a new message, then fans it out.
 * `access` comes from conversationAccess().
 */
export function sendMessage(ctx, user, access, input) {
  const { db } = ctx;
  const { conv, can } = access;
  if (user.state === 'restricted' && conv.type !== 'dm') {
    throw new HttpError(403, 'account_restricted', 'Your account is restricted to direct messages for now.', { until: user.state_until });
  }
  if (!access.member && conv.type !== 'channel') throw forbidden('Join this conversation to send messages.');

  const body = str(input.body ?? '', 'Message', { max: config.maxMessageLength, trim: false }).replace(/^\s+|\s+$/g, '');
  const fileIds = Array.isArray(input.fileIds) ? [...new Set(input.fileIds)].slice(0, 10) : [];
  const isForum = conv.type === 'channel' && conv.channel_type === 'forum';
  let threadId = input.threadId || null;

  if (isForum) {
    if (!threadId) throw bad('Forum channels only accept posts inside topics.');
    const thread = db.get('SELECT * FROM threads WHERE id = ? AND channel_id = ?', threadId, conv.id);
    if (!thread) throw bad('Topic not found.');
    if (!input._threadStarter && !can.replyThreads) throw forbidden('You cannot reply in this forum.');
    if (thread.locked && !can.manageMessages) throw forbidden('This topic is locked.');
  } else {
    threadId = null;
    if (!can.send) throw forbidden(access.blocked ? 'You cannot message this user.' : 'You cannot send messages here.');
  }

  // Slow mode (moderators are exempt).
  if (conv.slow_mode_seconds > 0 && !can.moderate) {
    const last = db.value("SELECT MAX(created_at) FROM messages WHERE conversation_id = ? AND sender_id = ? AND kind != 'system'", conv.id, user.id);
    const wait = last ? Math.ceil((last + conv.slow_mode_seconds * 1000 - Date.now()) / 1000) : 0;
    if (wait > 0) throw new HttpError(429, 'slow_mode', `Slow mode is on. You can send again in ${wait}s.`, { retryAfter: wait });
  }

  // Attachments reference existing stored files; nothing is copied.
  const files = fileIds.map((id) => {
    const f = db.get('SELECT * FROM files WHERE id = ? AND purged_at IS NULL', id);
    if (!f || f.owner_id !== user.id || f.trashed_at) throw bad('Attachments must come from your files.');
    if (f.moderation_status !== 'ok') throw forbidden(`"${f.filename}" cannot be shared.`);
    const media = ['image', 'video', 'audio'].includes(f.category);
    if (media && !can.sendMedia) throw forbidden('You cannot send media here.');
    if (!media && !can.uploadFiles) throw forbidden('You cannot send files here.');
    return f;
  });

  let kind = 'text';
  const data = {};
  if (input.sticker) {
    if (!STICKER_RE.test(String(input.sticker))) throw bad('Unknown sticker.');
    kind = 'sticker';
    data.sticker = String(input.sticker);
  } else if (input.poll) {
    const question = str(input.poll.question, 'Poll question', { min: 1, max: 300 });
    const options = Array.isArray(input.poll.options) ? input.poll.options.map((o, i) => str(o, `Option ${i + 1}`, { min: 1, max: 100 })) : [];
    if (options.length < 2 || options.length > 10) throw bad('Polls need 2–10 options.');
    kind = 'poll';
    data.poll = { question, options };
  } else if (files.length) {
    kind = input.voice && files.length === 1 && files[0].category === 'audio'
      ? 'voice'
      : files.every((f) => ['image', 'video'].includes(f.category)) ? 'media' : 'file';
  }
  if (kind === 'text' && !body) throw bad('Message is empty.');
  if (conv.type === 'channel' && conv.channel_type === 'media' && !threadId && !files.length && !input.replyToId) {
    throw bad('Media channels need an image, video or file with each post.');
  }

  const links = [...new Set(body.match(URL_RE) || [])].slice(0, 20);
  if (links.length) data.links = links;

  // Mentions: only members who can see the conversation get notified.
  const mentioned = new Set();
  let mentionEveryone = false;
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[2].toLowerCase();
    if (name === 'everyone' || name === 'here') {
      if (can.mentionEveryone) mentionEveryone = true;
      continue;
    }
    const u = db.get('SELECT id FROM users WHERE username = ?', name);
    if (u && u.id !== user.id) mentioned.add(u.id);
  }
  if (mentioned.size) data.mentions = [...mentioned];

  let replyTo = null;
  if (input.replyToId) {
    replyTo = db.get('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', input.replyToId, conv.id);
    if (!replyTo) throw bad('The message you are replying to is not in this conversation.');
  }

  const msg = {
    id: newId('msg'),
    created_at: Date.now(),
  };
  db.tx(() => {
    db.run(
      `INSERT INTO messages (id, conversation_id, thread_id, sender_id, kind, body, reply_to_id, data, has_links, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      msg.id, conv.id, threadId, user.id, kind, body, replyTo?.id ?? null,
      Object.keys(data).length ? JSON.stringify(data) : null, links.length ? 1 : 0, msg.created_at,
    );
    files.forEach((f, i) => {
      db.run('INSERT INTO message_attachments (message_id, file_id, position) VALUES (?,?,?)', msg.id, f.id, i);
      db.run(
        `UPDATE files SET share_count = share_count + 1,
           origin_message_id = COALESCE(origin_message_id, ?), origin_conversation_id = COALESCE(origin_conversation_id, ?)
         WHERE id = ?`, msg.id, conv.id, f.id,
      );
      db.run('INSERT INTO file_events (file_id, blob_id, type, user_id, created_at) VALUES (?,?,?,?,?)', f.id, f.blob_id, 'share', user.id, msg.created_at);
    });
    db.run('UPDATE conversations SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?', msg.created_at, conv.id);
    if (threadId) {
      db.run('UPDATE threads SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?', msg.created_at, threadId);
    }
    // Sender has read everything up to their own message; unhide DMs for both sides.
    db.run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', msg.created_at, conv.id, user.id);
    if (conv.type === 'dm') db.run('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ?', conv.id);
  });

  const row = db.get('SELECT * FROM messages WHERE id = ?', msg.id);
  const payload = serializeMessage(ctx, row);
  broadcast(ctx, conv, { type: 'message:new', message: payload });

  // Notifications for mentions and replies.
  const convName = conv.type === 'dm' ? null : conv.name;
  const notified = new Set();
  // People who muted the sender don't get notified by them.
  const mutedBy = new Set(db.all('SELECT user_id FROM user_mutes WHERE muted_id = ?', user.id).map((r) => r.user_id));
  const canSee = (uid) => {
    if (mutedBy.has(uid)) return false;
    if (conv.type === 'channel') return !!(channelPerms(db, conv, uid).perms & P.VIEW_CHANNEL);
    return !!db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, uid);
  };
  const base = { conversationId: conv.id, messageId: msg.id, threadId, conversationName: convName, spaceId: conv.space_id, from: miniUser(user), snippet: body.slice(0, 140) };
  if (replyTo && replyTo.sender_id && replyTo.sender_id !== user.id && canSee(replyTo.sender_id)) {
    notify(ctx, replyTo.sender_id, 'reply', base);
    notified.add(replyTo.sender_id);
  }
  for (const uid of mentioned) {
    if (!notified.has(uid) && canSee(uid)) {
      notify(ctx, uid, 'mention', base);
      notified.add(uid);
    }
  }
  if (mentionEveryone && conv.type !== 'dm') {
    const ids = conv.type === 'channel'
      ? db.all('SELECT user_id FROM space_members WHERE space_id = ? LIMIT 5000', conv.space_id).map((r) => r.user_id)
      : db.all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conv.id).map((r) => r.user_id);
    for (const uid of ids) {
      if (uid !== user.id && !notified.has(uid) && canSee(uid)) notify(ctx, uid, 'mention', { ...base, everyone: true });
    }
  }
  return payload;
}

/** Whether a viewer should see read receipts from `other` (both must have them on). */
export function receiptsVisible(viewer, other) {
  return privacyOf(viewer).readReceipts && privacyOf(other).readReceipts;
}
