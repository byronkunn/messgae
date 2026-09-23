import { h, str, bad, notFound, oneOf, bool } from '../../lib/http.js';
import { requireCap } from '../../lib/auth.js';
import { paginate } from '../../lib/pagination.js';
import { audit } from '../../lib/audit.js';
import { hasCap } from '../../lib/perms.js';
import { open } from '../../lib/crypto.js';
import { streamFile } from '../../lib/files.js';
import { serializeMessage, broadcast, fileSummary } from '../../lib/messaging.js';
import { notify } from '../../lib/users.js';
import { reportRow } from '../spaces.js';
import { requireReason, modAction, fileRow, HOUR, DAY } from './common.js';

const convRow = (c) => ({
  id: c.id,
  type: c.type,
  name: c.name || (c.type === 'dm' ? 'Direct message' : ''),
  spaceId: c.space_id,
  spaceName: c.space_name,
  channelType: c.channel_type,
  visibility: c.visibility,
  discoverable: !!c.discoverable,
  exploreRemoved: !!c.explore_removed,
  createdAt: c.created_at,
  lastMessageAt: c.last_message_at,
  messageCount: c.message_count,
  memberCount: c.member_count,
  removed: !!c.removed_at,
});

export default function adminContent(r, ctx) {
  const { db } = ctx;

  // ---- Conversations (metadata is available to moderators; contents need Evidence Access) ----

  function listConversations(req, res, fixedType) {
    const where = [];
    const params = [];
    const type = fixedType || (req.query.type ? oneOf(req.query.type, 'type', ['dm', 'group', 'channel']) : null);
    if (type) { where.push('c.type = ?'); params.push(type); }
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push("(c.id = ? OR c.name LIKE ? ESCAPE '\\' OR c.space_id = ?)");
      params.push(q, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`, q);
    }
    if (req.query.memberId) {
      where.push('EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ?)');
      params.push(String(req.query.memberId));
    }
    if (req.query.spaceId) { where.push('c.space_id = ?'); params.push(String(req.query.spaceId)); }
    res.json(paginate(db, {
      columns: `c.*, s.name AS space_name, (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS member_count`,
      from: 'conversations c LEFT JOIN spaces s ON s.id = c.space_id', where, params, query: req.query,
      sorts: { created: 'c.created_at', last_message: 'COALESCE(c.last_message_at, 0)', messages: 'c.message_count' },
      defaultSort: 'last_message', idCol: 'c.id', map: convRow,
    }));
  }

  r.get('/conversations', requireCap('conversations.meta'), h((req, res) => listConversations(req, res)));
  r.get('/groups', requireCap('conversations.meta'), h((req, res) => listConversations(req, res, 'group')));
  r.get('/channels', requireCap('conversations.meta'), h((req, res) => listConversations(req, res, 'channel')));

  const loadConv = (id) => {
    const c = db.get('SELECT c.*, s.name AS space_name FROM conversations c LEFT JOIN spaces s ON s.id = c.space_id WHERE c.id = ?', id);
    if (!c) throw notFound('Conversation');
    return c;
  };

  r.get('/conversations/:id', requireCap('conversations.meta'), h((req, res) => {
    const c = loadConv(req.params.id);
    const memberCount = c.type === 'channel'
      ? Number(db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ?', c.space_id))
      : Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', c.id));
    const storage = db.get(
      `SELECT COUNT(DISTINCT f.id) AS files, COALESCE(SUM(f.size), 0) AS bytes FROM messages m JOIN message_attachments a ON a.message_id = m.id
       JOIN files f ON f.id = a.file_id WHERE m.conversation_id = ? AND m.deleted_at IS NULL`, c.id,
    );
    const activity = db.all(
      `SELECT CAST(created_at / ${DAY} AS INTEGER) AS b, COUNT(*) AS value FROM messages WHERE conversation_id = ? AND created_at > ? GROUP BY b`,
      c.id, Date.now() - 30 * DAY,
    );
    res.json({
      conversation: {
        ...convRow({ ...c, member_count: memberCount }),
        description: c.description,
        slowModeSeconds: c.slow_mode_seconds,
        locked: !!c.locked,
        storageBytes: storage.bytes,
        fileCount: storage.files,
        messages24h: Number(db.value('SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND created_at > ?', c.id, Date.now() - DAY)),
        activity: activity.map((a) => ({ t: a.b * DAY, value: a.value })),
        reports: Number(db.value('SELECT COUNT(*) FROM reports WHERE conversation_id = ?', c.id)),
      },
      canReadContent: hasCap(req.user, 'evidence.access'),
      privacyNotice: 'Messages on this service are server-readable (not end-to-end encrypted). Viewing contents requires Evidence Access, a stated reason, and is audited.',
    });
  }));

  r.get('/conversations/:id/members', requireCap('conversations.meta'), h((req, res) => {
    const c = loadConv(req.params.id);
    const base = c.type === 'channel'
      ? { from: 'space_members m JOIN users u ON u.id = m.user_id', where: ['m.space_id = ?'], params: [c.space_id], role: "'member'" }
      : { from: 'conversation_members m JOIN users u ON u.id = m.user_id', where: ['m.conversation_id = ?'], params: [c.id], role: 'm.role' };
    res.json(paginate(db, {
      columns: `u.id, u.username, u.display_name, u.state, ${base.role} AS role, m.joined_at`,
      from: base.from, where: base.where, params: base.params, query: req.query,
      sorts: { joined: 'm.joined_at', username: 'u.username' }, defaultSort: 'joined', idCol: 'u.id',
      map: (m) => ({ id: m.id, username: m.username, displayName: m.display_name, state: m.state, role: m.role, joinedAt: m.joined_at }),
    }));
  }));

  r.get('/conversations/:id/reports', requireCap('reports.review'), h((req, res) => {
    const c = loadConv(req.params.id);
    res.json(paginate(db, {
      columns: 'r.*, u.username AS reporter_username', from: 'reports r JOIN users u ON u.id = r.reporter_id',
      where: ['r.conversation_id = ?'], params: [c.id], query: req.query, sorts: { created: 'r.created_at' }, defaultSort: 'created', idCol: 'r.id',
      map: reportRow,
    }));
  }));

  r.get('/conversations/:id/moderation', requireCap('conversations.meta'), h((req, res) => {
    const c = loadConv(req.params.id);
    res.json(paginate(db, {
      columns: 'a.*, u.username AS actor_username', from: 'moderation_actions a LEFT JOIN users u ON u.id = a.actor_id',
      where: ["(a.target_id = ? OR a.scope = ? OR (a.target_type = 'message' AND a.target_id IN (SELECT id FROM messages WHERE conversation_id = ?)))"],
      params: [c.id, `group:${c.id}`, c.id], query: req.query, sorts: { created: 'a.created_at' }, defaultSort: 'created', idCol: 'a.id',
      map: (a) => ({ id: a.id, actor: a.actor_username, scope: a.scope, targetType: a.target_type, targetId: a.target_id, action: a.action, reason: a.reason, createdAt: a.created_at }),
    }));
  }));

  /** Reading message contents: Evidence Access + privileged session + reason, always audited. */
  r.get('/conversations/:id/messages', requireCap('evidence.access'), h((req, res) => {
    const c = loadConv(req.params.id);
    const reason = requireReason(req);
    const where = ['m.conversation_id = ?'];
    const params = [c.id];
    const q = req.query;
    if (q.userId) { where.push('m.sender_id = ?'); params.push(String(q.userId)); }
    if (q.messageId) { where.push('m.id = ?'); params.push(String(q.messageId)); }
    if (q.from) { where.push('m.created_at >= ?'); params.push(Number(new Date(q.from))); }
    if (q.to) { where.push('m.created_at <= ?'); params.push(Number(new Date(q.to)) + (String(q.to).length <= 10 ? DAY - 1 : 0)); }
    if (q.text) { where.push("m.body LIKE ? ESCAPE '\\'"); params.push(`%${String(q.text).replace(/[%_\\]/g, (x) => `\\${x}`)}%`); }
    if (q.filename || q.fileType) {
      const sub = ['a.message_id = m.id'];
      if (q.filename) { sub.push("f.filename LIKE ? ESCAPE '\\'"); params.push(`%${String(q.filename).replace(/[%_\\]/g, (x) => `\\${x}`)}%`); }
      if (q.fileType) { sub.push('f.category = ?'); params.push(oneOf(q.fileType, 'fileType', ['image', 'video', 'audio', 'document', 'archive', 'other'])); }
      where.push(`EXISTS (SELECT 1 FROM message_attachments a JOIN files f ON f.id = a.file_id WHERE ${sub.join(' AND ')})`);
    }
    if (q.kind === 'media') where.push("m.kind IN ('media','voice')");
    if (q.kind === 'files') where.push("m.kind = 'file'");
    if (q.kind === 'links') where.push('m.has_links = 1');
    const page = paginate(db, {
      columns: 'm.*', from: 'messages m', where, params, query: q,
      sorts: { created: 'm.created_at' }, defaultSort: 'created', idCol: 'm.id',
    });
    // Admins see deleted message bodies are gone too: deletion clears content server-side.
    page.items = page.items.map((m) => ({ ...serializeMessage(ctx, m), threadId: m.thread_id, deletedBy: m.deleted_by }));
    audit(db, {
      actor: req.user, action: 'conversation.viewed', targetType: 'conversation', targetId: c.id, reason,
      detail: { filters: Object.fromEntries(Object.entries(q).filter(([k]) => !['reason', 'cursor'].includes(k))), page: page.page }, req,
    });
    res.json(page);
  }));

  r.post('/messages/:id/remove', requireCap('content.remove'), h((req, res) => {
    const m = db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) throw notFound('Message');
    const reason = requireReason(req);
    db.run('UPDATE messages SET deleted_at = ?, deleted_by = ?, body = ?, data = NULL, pinned_at = NULL WHERE id = ?', Date.now(), req.user.id, '', m.id);
    db.run('DELETE FROM reactions WHERE message_id = ?', m.id);
    const conv = db.get('SELECT * FROM conversations WHERE id = ?', m.conversation_id);
    if (conv) broadcast(ctx, conv, { type: 'message:delete', message: serializeMessage(ctx, db.get('SELECT * FROM messages WHERE id = ?', m.id)) });
    modAction(db, { actorId: req.user.id, targetType: 'message', targetId: m.id, action: 'remove_message', reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: 'message.removed', targetType: 'message', targetId: m.id, reason, detail: { conversationId: m.conversation_id, senderId: m.sender_id }, req });
    if (m.sender_id) notify(ctx, m.sender_id, 'moderation', { action: 'message_removed', reason });
    res.json({ ok: true });
  }));

  // ---- Spaces --------------------------------------------------------------------------

  r.get('/spaces', requireCap('conversations.meta'), h((req, res) => {
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) { where.push("(s.id = ? OR s.name LIKE ? ESCAPE '\\')"); params.push(q, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`); }
    if (req.query.visibility) { where.push('s.visibility = ?'); params.push(oneOf(req.query.visibility, 'visibility', ['public', 'private'])); }
    if (req.query.removed === '1') where.push('s.removed_at IS NOT NULL');
    res.json(paginate(db, {
      columns: `s.*, u.username AS owner_username, (SELECT COUNT(*) FROM space_members m WHERE m.space_id = s.id) AS members,
        (SELECT COUNT(*) FROM conversations c WHERE c.space_id = s.id AND c.removed_at IS NULL) AS channels`,
      from: 'spaces s JOIN users u ON u.id = s.owner_id', where, params, query: req.query,
      sorts: { created: 's.created_at', name: 's.name' }, defaultSort: 'created', idCol: 's.id',
      map: (s) => ({
        id: s.id, name: s.name, ownerId: s.owner_id, ownerUsername: s.owner_username, visibility: s.visibility, discoverable: !!s.discoverable,
        exploreRemoved: !!s.explore_removed, plan: s.plan, members: s.members, channels: s.channels, createdAt: s.created_at, removed: !!s.removed_at,
      }),
    }));
  }));

  r.get('/spaces/:id', requireCap('conversations.meta'), h((req, res) => {
    const s = db.get('SELECT s.*, u.username AS owner_username FROM spaces s JOIN users u ON u.id = s.owner_id WHERE s.id = ?', req.params.id);
    if (!s) throw notFound('Space');
    const channels = db.all("SELECT id, name, channel_type, is_private, message_count, last_message_at, removed_at FROM conversations WHERE space_id = ? ORDER BY position", s.id);
    const storage = Number(db.value(
      `SELECT COALESCE(SUM(f.size), 0) FROM conversations c JOIN messages m ON m.conversation_id = c.id JOIN message_attachments a ON a.message_id = m.id
       JOIN files f ON f.id = a.file_id WHERE c.space_id = ? AND m.deleted_at IS NULL`, s.id,
    ));
    res.json({
      space: {
        id: s.id, name: s.name, description: s.description, ownerId: s.owner_id, ownerUsername: s.owner_username, visibility: s.visibility,
        discoverable: !!s.discoverable, exploreRemoved: !!s.explore_removed, joinMode: s.join_mode, plan: s.plan, createdAt: s.created_at,
        removedAt: s.removed_at, storageBytes: storage,
        members: Number(db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ?', s.id)),
        messages7d: Number(db.value('SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.space_id = ? AND m.created_at > ?', s.id, Date.now() - 7 * DAY)),
        reports: Number(db.value('SELECT COUNT(*) FROM reports WHERE space_id = ?', s.id)),
      },
      channels: channels.map((c) => ({ id: c.id, name: c.name, channelType: c.channel_type, isPrivate: !!c.is_private, messageCount: c.message_count, lastMessageAt: c.last_message_at, removed: !!c.removed_at })),
    });
  }));

  r.post('/spaces/:id/remove', requireCap('spaces.remove'), h((req, res) => {
    const s = db.get('SELECT * FROM spaces WHERE id = ?', req.params.id);
    if (!s) throw notFound('Space');
    const reason = requireReason(req);
    const restore = bool(req.body.restore);
    db.run('UPDATE spaces SET removed_at = ? WHERE id = ?', restore ? null : Date.now(), s.id);
    db.run('UPDATE conversations SET removed_at = ? WHERE space_id = ?', restore ? null : Date.now(), s.id);
    modAction(db, { actorId: req.user.id, targetType: 'space', targetId: s.id, action: restore ? 'restore_space' : 'remove_space', reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: restore ? 'space.restored' : 'space.removed', targetType: 'space', targetId: s.id, reason, req });
    if (!restore) notify(ctx, s.owner_id, 'moderation', { action: 'space_removed', spaceName: s.name, reason });
    res.json({ ok: true });
  }));

  r.patch('/spaces/:id/plan', requireCap('users.plan'), h((req, res) => {
    const s = db.get('SELECT * FROM spaces WHERE id = ?', req.params.id);
    if (!s) throw notFound('Space');
    const plan = oneOf(req.body.plan, 'Plan', ['free', 'pro']);
    const reason = requireReason(req);
    db.run('UPDATE spaces SET plan = ? WHERE id = ?', plan, s.id);
    audit(db, { actor: req.user, action: 'space.plan_changed', targetType: 'space', targetId: s.id, reason, detail: { from: s.plan, to: plan }, req });
    res.json({ ok: true });
  }));

  // ---- Explore management ------------------------------------------------------------------

  r.get('/explore', requireCap('explore.manage'), h((req, res) => {
    const kind = oneOf(req.query.kind, 'kind', ['space', 'group'], 'space');
    const where = kind === 'space'
      ? ["s.visibility = 'public'", 's.removed_at IS NULL']
      : ["s.type = 'group'", "s.visibility = 'public'", 's.removed_at IS NULL'];
    if (req.query.removed === '1') where.push('s.explore_removed = 1');
    const table = kind === 'space' ? 'spaces s' : 'conversations s';
    const members = kind === 'space' ? '(SELECT COUNT(*) FROM space_members m WHERE m.space_id = s.id)' : '(SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = s.id)';
    res.json(paginate(db, {
      columns: `s.id, s.name, s.description, s.discoverable, s.explore_removed, s.topic, s.created_at, ${members} AS members`,
      from: table, where, params: [], query: req.query, sorts: { created: 's.created_at', name: 's.name' }, defaultSort: 'created', idCol: 's.id',
      map: (s) => ({ kind, id: s.id, name: s.name, description: s.description, discoverable: !!s.discoverable, exploreRemoved: !!s.explore_removed, topic: s.topic, members: s.members, createdAt: s.created_at }),
    }));
  }));

  r.post('/explore/:kind/:id', requireCap('explore.manage'), h((req, res) => {
    const kind = oneOf(req.params.kind, 'kind', ['space', 'group']);
    const reason = requireReason(req);
    const removed = bool(req.body.removed, true) ? 1 : 0;
    const table = kind === 'space' ? 'spaces' : 'conversations';
    const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, req.params.id);
    if (!row) throw notFound(kind);
    db.run(`UPDATE ${table} SET explore_removed = ? WHERE id = ?`, removed, row.id);
    modAction(db, { actorId: req.user.id, targetType: kind, targetId: row.id, action: removed ? 'explore_remove' : 'explore_restore', reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: removed ? 'explore.removed' : 'explore.restored', targetType: kind, targetId: row.id, reason, req });
    res.json({ ok: true });
  }));

  // ---- Files inspector ---------------------------------------------------------------------

  const FILE_TABS = {
    popular: 'f.download_count + f.view_count + f.share_count * 5',
    downloaded: 'f.download_count',
    shared: 'f.share_count',
    bandwidth: 'f.bandwidth_bytes',
    largest: 'f.size',
    newest: 'f.created_at',
  };

  r.get('/files', requireCap('files.inspect'), h((req, res) => {
    const tab = oneOf(req.query.tab, 'tab', [...Object.keys(FILE_TABS), 'trending'], 'popular');
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push("(f.id = ? OR f.sha256 = ? OR f.filename LIKE ? ESCAPE '\\')");
      params.push(q, q.toLowerCase(), `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }
    if (req.query.type) { where.push('f.category = ?'); params.push(oneOf(req.query.type, 'type', ['image', 'video', 'audio', 'document', 'archive', 'other'])); }
    if (req.query.status) { where.push('f.moderation_status = ?'); params.push(oneOf(req.query.status, 'status', ['ok', 'restricted', 'quarantined', 'removed'])); }
    let columns = 'f.*, u.username AS owner_username';
    let sortExpr = FILE_TABS[tab];
    const extraParams = [];
    if (tab === 'trending') {
      // Downloads in the last window vs. the file's own baseline over the prior 7 days.
      const win = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY }[req.query.window] || 6 * HOUR;
      const t = Date.now();
      columns += `, (SELECT COUNT(*) FROM file_events e WHERE e.file_id = f.id AND e.type IN ('download','link_download') AND e.created_at > ${t - win}) AS recent,
        (SELECT COUNT(*) FROM file_events e WHERE e.file_id = f.id AND e.type IN ('download','link_download') AND e.created_at > ${t - win - 7 * DAY} AND e.created_at <= ${t - win}) AS baseline`;
      sortExpr = `((SELECT COUNT(*) FROM file_events e WHERE e.file_id = f.id AND e.type IN ('download','link_download') AND e.created_at > ${t - win}) * 1.0 /
        ((SELECT COUNT(*) FROM file_events e WHERE e.file_id = f.id AND e.type IN ('download','link_download') AND e.created_at > ${t - win - 7 * DAY} AND e.created_at <= ${t - win}) * ${win / (7 * DAY)} + 1))`;
      where.push(`EXISTS (SELECT 1 FROM file_events e WHERE e.file_id = f.id AND e.type IN ('download','link_download') AND e.created_at > ${t - win})`);
      res.json({
        ...paginate(db, {
          columns, from: 'files f JOIN users u ON u.id = f.owner_id', where, params: [...params, ...extraParams], query: { ...req.query, sort: 'score' },
          sorts: { score: sortExpr }, defaultSort: 'score', idCol: 'f.id',
          map: (f) => {
            const expected = (f.baseline * win) / (7 * DAY);
            return { ...fileRow(f), windowMs: win, growthPct: Math.round(((f.recent - expected) / Math.max(expected, 1)) * 100) };
          },
        }),
        tab,
      });
      return;
    }
    res.json({
      ...paginate(db, {
        columns, from: 'files f JOIN users u ON u.id = f.owner_id', where, params, query: { ...req.query, sort: 'metric' },
        sorts: { metric: sortExpr }, defaultSort: 'metric', idCol: 'f.id', map: fileRow,
      }),
      tab,
    });
  }));

  r.get('/files/:id', requireCap('files.inspect'), h((req, res) => {
    const f = db.get('SELECT f.*, u.username AS owner_username FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?', req.params.id);
    if (!f) throw notFound('File');
    const t = Date.now();
    const velocity = (ms) => Number(db.value("SELECT COUNT(*) FROM file_events WHERE file_id = ? AND type IN ('download','link_download') AND created_at > ?", f.id, t - ms));
    const origin = f.origin_message_id ? db.get('SELECT id, conversation_id, created_at, sender_id FROM messages WHERE id = ?', f.origin_message_id) : null;
    const conv = f.origin_conversation_id ? db.get('SELECT c.id, c.type, c.name, c.space_id, s.name AS space_name FROM conversations c LEFT JOIN spaces s ON s.id = c.space_id WHERE c.id = ?', f.origin_conversation_id) : null;
    const uniqueDownloaders = Number(db.value("SELECT COUNT(DISTINCT user_id) FROM file_events WHERE file_id = ? AND type IN ('download','link_download') AND user_id IS NOT NULL", f.id));
    res.json({
      file: {
        ...fileRow(f),
        uploader: { id: f.owner_id, username: f.owner_username },
        originMessageId: f.origin_message_id,
        originMessageAt: origin?.created_at,
        conversation: conv ? { id: conv.id, type: conv.type, name: conv.name, spaceId: conv.space_id, spaceName: conv.space_name } : null,
        attachedInMessages: Number(db.value('SELECT COUNT(*) FROM message_attachments WHERE file_id = ?', f.id)),
        sameContentCopies: Number(db.value('SELECT COUNT(*) FROM files WHERE sha256 = ? AND id != ?', f.sha256, f.id)),
        links: db.all('SELECT id, audience, expires_at, max_downloads, downloads, revoked_at, created_at, password_verifier IS NOT NULL AS pw FROM file_links WHERE file_id = ?', f.id)
          .map((l) => ({ id: l.id, audience: l.audience, expiresAt: l.expires_at, maxDownloads: l.max_downloads, downloads: l.downloads, revokedAt: l.revoked_at, createdAt: l.created_at, passwordProtected: !!l.pw })),
        velocity: { h1: velocity(HOUR), h6: velocity(6 * HOUR), h24: velocity(DAY), d7: velocity(7 * DAY) },
        uniqueDownloaders,
        reports: db.all("SELECT id, reason, status, created_at FROM reports WHERE target_type = 'file' AND target_id = ? ORDER BY created_at DESC LIMIT 20", f.id)
          .map((x) => ({ id: x.id, reason: x.reason, status: x.status, createdAt: x.created_at })),
        moderation: db.all("SELECT a.*, u.username FROM moderation_actions a LEFT JOIN users u ON u.id = a.actor_id WHERE a.target_type = 'file' AND a.target_id = ? ORDER BY a.created_at DESC LIMIT 20", f.id)
          .map((a) => ({ action: a.action, reason: a.reason, actor: a.username, createdAt: a.created_at })),
      },
      canAccessContent: hasCap(req.user, 'evidence.access'),
    });
  }));

  r.get('/files/:id/content', requireCap('evidence.access'), h((req, res) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File');
    const reason = requireReason(req);
    audit(db, { actor: req.user, action: 'file.downloaded', targetType: 'file', targetId: f.id, reason, detail: { filename: f.filename, sha256: f.sha256 }, req });
    // Admin evidence downloads are not counted as user downloads.
    streamFile(ctx, req, res, f, { download: !req.query.inline, track: false });
  }));

  r.post('/files/:id/reveal-password', requireCap('evidence.access'), h((req, res) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File');
    const reason = requireReason(req);
    const out = { filePassword: null, linkPasswords: [] };
    if (f.password_sealed) out.filePassword = open('filePassword', f.password_sealed, `file:${f.id}`);
    for (const l of db.all('SELECT id, password_sealed FROM file_links WHERE file_id = ? AND password_sealed IS NOT NULL', f.id)) {
      out.linkPasswords.push({ linkId: l.id, password: open('filePassword', l.password_sealed, `link:${l.id}`) });
    }
    if (!out.filePassword && !out.linkPasswords.length) throw bad('This file has no stored passwords.');
    audit(db, { actor: req.user, action: 'file.password_revealed', targetType: 'file', targetId: f.id, reason, detail: { links: out.linkPasswords.map((l) => l.linkId) }, req });
    res.json(out);
  }));

  r.post('/files/:id/moderation', requireCap('content.remove'), h((req, res) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', req.params.id);
    if (!f) throw notFound('File');
    const reason = requireReason(req);
    const status = oneOf(req.body.status, 'Status', ['ok', 'restricted', 'quarantined', 'removed']);
    // Optionally apply to every stored copy with identical content (e.g. malware re-uploads).
    const ids = bool(req.body.allCopies) ? db.all('SELECT id FROM files WHERE sha256 = ?', f.sha256).map((x) => x.id) : [f.id];
    for (const id of ids) {
      db.run('UPDATE files SET moderation_status = ? WHERE id = ?', status, id);
      if (status !== 'ok') db.run('UPDATE file_links SET revoked_at = COALESCE(revoked_at, ?) WHERE file_id = ?', Date.now(), id);
    }
    modAction(db, { actorId: req.user.id, targetType: 'file', targetId: f.id, action: `file_${status}`, reason, reportId: req.body.reportId });
    audit(db, { actor: req.user, action: status === 'removed' ? 'file.removed' : `file.${status}`, targetType: 'file', targetId: f.id, reason, detail: { copies: ids.length }, req });
    if (status === 'removed' || status === 'quarantined') notify(ctx, f.owner_id, 'moderation', { action: `file_${status}`, filename: f.filename, reason });
    res.json({ ok: true, affected: ids.length });
  }));

  // ---- Reports --------------------------------------------------------------------------------

  r.get('/reports', requireCap('reports.review'), h((req, res) => {
    const where = [];
    const params = [];
    const status = req.query.status || 'open';
    if (status !== 'all') { where.push('r.status = ?'); params.push(oneOf(status, 'status', ['open', 'reviewing', 'escalated', 'resolved', 'dismissed'])); }
    if (req.query.reason) { where.push('r.reason = ?'); params.push(String(req.query.reason)); }
    if (req.query.targetType) { where.push('r.target_type = ?'); params.push(String(req.query.targetType)); }
    if (req.query.targetId) { where.push('r.target_id = ?'); params.push(String(req.query.targetId)); }
    if (req.query.scope === 'site') where.push('r.space_id IS NULL');
    if (req.query.scope === 'space') where.push('r.space_id IS NOT NULL');
    res.json(paginate(db, {
      columns: 'r.*, u.username AS reporter_username', from: 'reports r JOIN users u ON u.id = r.reporter_id', where, params, query: req.query,
      sorts: { created: 'r.created_at', updated: 'r.updated_at' }, defaultSort: 'created', idCol: 'r.id', map: reportRow,
    }));
  }));

  r.get('/reports/:id', requireCap('reports.review'), h((req, res) => {
    const rep = db.get('SELECT r.*, u.username AS reporter_username FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.id = ?', req.params.id);
    if (!rep) throw notFound('Report');
    let target = null;
    if (rep.target_type === 'user') {
      const u = db.get('SELECT id, username, display_name, state, site_role, created_at FROM users WHERE id = ?', rep.target_id);
      target = u && { id: u.id, username: u.username, displayName: u.display_name, state: u.state, siteRole: u.site_role, createdAt: u.created_at };
    } else if (rep.target_type === 'message') {
      const m = db.get('SELECT id, sender_id, conversation_id, deleted_at, created_at FROM messages WHERE id = ?', rep.target_id);
      target = m && { id: m.id, senderId: m.sender_id, conversationId: m.conversation_id, deleted: !!m.deleted_at, createdAt: m.created_at };
    } else if (rep.target_type === 'file') {
      const f = db.get('SELECT * FROM files WHERE id = ?', rep.target_id);
      target = f && fileSummary(f);
    } else if (rep.target_type === 'space') {
      const s = db.get('SELECT id, name, owner_id, removed_at, explore_removed FROM spaces WHERE id = ?', rep.target_id);
      target = s && { id: s.id, name: s.name, ownerId: s.owner_id, removed: !!s.removed_at, exploreRemoved: !!s.explore_removed };
    } else {
      const c = db.get('SELECT id, type, name, removed_at FROM conversations WHERE id = ?', rep.target_id);
      target = c && { id: c.id, type: c.type, name: c.name, removed: !!c.removed_at };
    }
    const related = Number(db.value('SELECT COUNT(*) FROM reports WHERE target_type = ? AND target_id = ? AND id != ?', rep.target_type, rep.target_id, rep.id));
    const actions = db.all("SELECT a.*, u.username FROM moderation_actions a LEFT JOIN users u ON u.id = a.actor_id WHERE a.report_id = ? ORDER BY a.created_at", rep.id)
      .map((a) => ({ action: a.action, reason: a.reason, actor: a.username, createdAt: a.created_at }));
    res.json({ report: reportRow(rep), target, relatedReports: related, actions });
  }));

  r.patch('/reports/:id', requireCap('reports.review'), h((req, res) => {
    const rep = db.get('SELECT * FROM reports WHERE id = ?', req.params.id);
    if (!rep) throw notFound('Report');
    const status = oneOf(req.body.status, 'Status', ['open', 'reviewing', 'escalated', 'resolved', 'dismissed']);
    if (status === 'escalated' && !hasCap(req.user, 'reports.escalate')) throw bad('You cannot escalate reports.');
    const resolution = str(req.body.resolution, 'Resolution', { max: 2000 });
    db.run('UPDATE reports SET status = ?, resolution = COALESCE(NULLIF(?, \'\'), resolution), assigned_to = ?, updated_at = ? WHERE id = ?',
      status, resolution, req.user.id, Date.now(), rep.id);
    modAction(db, { actorId: req.user.id, targetType: 'report', targetId: rep.id, action: `report_${status}`, reason: resolution || null, reportId: rep.id });
    if (status === 'escalated') {
      for (const a of db.all("SELECT id FROM users WHERE site_role IN ('site_admin','super_admin')")) {
        notify(ctx, a.id, 'escalation', { reportId: rep.id, reason: rep.reason, from: req.user.username });
      }
    }
    if (status === 'resolved' || status === 'dismissed') {
      notify(ctx, rep.reporter_id, 'report_update', { reportId: rep.id, status });
    }
    res.json({ ok: true });
  }));

  r.get('/moderation', requireCap('reports.review'), h((req, res) => {
    const where = [];
    const params = [];
    if (req.query.targetType) { where.push('a.target_type = ?'); params.push(String(req.query.targetType)); }
    if (req.query.targetId) { where.push('a.target_id = ?'); params.push(String(req.query.targetId)); }
    if (req.query.actorId) { where.push('a.actor_id = ?'); params.push(String(req.query.actorId)); }
    if (req.query.scope === 'site') where.push("a.scope = 'site'");
    res.json(paginate(db, {
      columns: 'a.*, u.username AS actor_username', from: 'moderation_actions a LEFT JOIN users u ON u.id = a.actor_id', where, params, query: req.query,
      sorts: { created: 'a.created_at' }, defaultSort: 'created', idCol: 'a.id',
      map: (a) => ({ id: a.id, actor: a.actor_username, actorId: a.actor_id, scope: a.scope, targetType: a.target_type, targetId: a.target_id, action: a.action, reason: a.reason, reportId: a.report_id, createdAt: a.created_at, expiresAt: a.expires_at }),
    }));
  }));

}
