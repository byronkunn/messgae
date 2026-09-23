import { Router } from 'express';
import { h, str, bad, forbidden, notFound, int, bool, oneOf, HttpError } from '../lib/http.js';
import { requireUser, notRestricted } from '../lib/auth.js';
import { newId } from '../lib/crypto.js';
import {
  P, ALL_PERMS, PERM_LABELS, DEFAULT_ROLE_PERMS, spacePerms, channelPerms,
} from '../lib/perms.js';
import { miniUser, notify, publicProfile } from '../lib/users.js';
import { unreadCount, lastMessagePreview, systemMessage } from '../lib/messaging.js';
import { createInvite, inviteView, EXPLORE_TOPICS } from './conversations.js';
import { config } from '../config.js';

const CHANNEL_TYPES = ['text', 'announcement', 'media', 'forum'];

export const spacePlanOf = (space) => config.spacePlans[space.plan] || config.spacePlans.free;

export function spaceAudit(db, spaceId, actorId, action, target = null, detail = null) {
  db.run('INSERT INTO space_audit (id, space_id, actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('sau'), spaceId, actorId, action, target, detail ? JSON.stringify(detail) : null, Date.now());
}

export function addSpaceMember(ctx, space, userId) {
  ctx.db.run('INSERT OR IGNORE INTO space_members (space_id, user_id, joined_at) VALUES (?,?,?)', space.id, userId, Date.now());
  ctx.db.run("DELETE FROM join_requests WHERE target_type = 'space' AND target_id = ? AND user_id = ?", space.id, userId);
}

export function spaceSummary(ctx, s, extra = {}) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    iconFileId: s.icon_file_id,
    bannerFileId: s.banner_file_id,
    visibility: s.visibility,
    discoverable: !!s.discoverable,
    joinMode: s.join_mode,
    topic: s.topic,
    language: s.language,
    plan: s.plan,
    ownerId: s.owner_id,
    createdAt: s.created_at,
    memberCount: Number(ctx.db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ?', s.id)),
    ...extra,
  };
}

function roleView(r) {
  return { id: r.id, name: r.name, color: r.color, position: r.position, permissions: r.permissions, systemKey: r.system_key };
}

function channelView(ctx, c, userId, perms, member) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    channelType: c.channel_type,
    categoryId: c.category_id,
    position: c.position,
    isPrivate: !!c.is_private,
    locked: !!c.locked,
    slowModeSeconds: c.slow_mode_seconds,
    unread: member ? unreadCount(ctx, c, ctx.db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', c.id, userId), userId) : 0,
    lastMessageAt: c.last_message_at,
    perms,
  };
}

export default function spaceRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  function load(req, { needMember = true } = {}) {
    const space = db.get('SELECT * FROM spaces WHERE id = ? AND removed_at IS NULL', req.params.id);
    if (!space) throw notFound('Space');
    const sp = spacePerms(db, space, req.user.id);
    if (!sp.member && needMember) {
      if (space.visibility !== 'public') throw notFound('Space');
      throw forbidden('Join this Space first.');
    }
    if (!sp.member && space.visibility !== 'public') throw notFound('Space');
    return { space, sp };
  }

  const need = (sp, flag, msg) => {
    if (!(sp.perms & flag)) throw forbidden(msg || 'You do not have permission to do that in this Space.');
  };

  function loadChannel(space, channelId) {
    const c = db.get("SELECT * FROM conversations WHERE id = ? AND space_id = ? AND type = 'channel' AND removed_at IS NULL", channelId, space.id);
    if (!c) throw notFound('Channel');
    return c;
  }

  // ---- Create / list / detail --------------------------------------------------------

  r.post('/', h((req, res) => {
    notRestricted(req);
    limiter.check(`space:${req.user.id}`, 10, 60 * 60_000);
    const name = str(req.body.name, 'Space name', { min: 2, max: 80 });
    const t = Date.now();
    const id = newId('spc');
    db.tx(() => {
      db.run(
        `INSERT INTO spaces (id, name, description, owner_id, visibility, discoverable, join_mode, topic, language, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, name, str(req.body.description, 'Description', { max: 1000 }), req.user.id,
        oneOf(req.body.visibility, 'Visibility', ['public', 'private'], 'private'),
        bool(req.body.discoverable) && req.body.visibility === 'public' ? 1 : 0,
        oneOf(req.body.joinMode, 'Join mode', ['open', 'approval', 'invite'], 'invite'),
        oneOf(req.body.topic || '', 'Topic', ['', ...EXPLORE_TOPICS], ''),
        str(req.body.language || 'en', 'Language', { max: 8 }), t,
      );
      const roles = {
        everyone: newId('rol'), moderator: newId('rol'), admin: newId('rol'),
      };
      db.run('INSERT INTO space_roles (id, space_id, name, position, permissions, system_key, created_at) VALUES (?,?,?,?,?,?,?)', roles.everyone, id, '@everyone', 0, DEFAULT_ROLE_PERMS.everyone, 'everyone', t);
      db.run('INSERT INTO space_roles (id, space_id, name, color, position, permissions, system_key, created_at) VALUES (?,?,?,?,?,?,?,?)', roles.moderator, id, 'Moderator', '#2e9d6a', 10, DEFAULT_ROLE_PERMS.moderator, 'moderator', t);
      db.run('INSERT INTO space_roles (id, space_id, name, color, position, permissions, system_key, created_at) VALUES (?,?,?,?,?,?,?,?)', roles.admin, id, 'Admin', '#d9544d', 20, DEFAULT_ROLE_PERMS.admin, 'admin', t);
      db.run('INSERT INTO space_members (space_id, user_id, joined_at) VALUES (?,?,?)', id, req.user.id, t);

      const cat = (n, pos) => {
        const cid = newId('cat');
        db.run('INSERT INTO space_categories (id, space_id, name, position) VALUES (?,?,?,?)', cid, id, n, pos);
        return cid;
      };
      const info = cat('INFORMATION', 0);
      const general = cat('GENERAL', 1);
      const mk = (n, type, catId, pos, desc = '') => {
        const cid = newId('cnv');
        db.run(
          `INSERT INTO conversations (id, type, name, description, created_by, created_at, space_id, category_id, channel_type, position)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, cid, 'channel', n, desc, req.user.id, t, id, catId, type, pos,
        );
        return cid;
      };
      const ann = mk('announcements', 'announcement', info, 0, 'Official updates');
      applyAnnouncementDefaults(db, ann, id);
      const rules = mk('rules', 'announcement', info, 1, 'Read before posting');
      applyAnnouncementDefaults(db, rules, id);
      mk('general', 'text', general, 0, 'Chat about anything');
      mk('media', 'media', general, 1, 'Share photos, videos and files');
    });
    spaceAudit(db, id, req.user.id, 'space.create');
    res.status(201).json({ space: spaceSummary(ctx, db.get('SELECT * FROM spaces WHERE id = ?', id)) });
  }));

  r.get('/', h((req, res) => {
    const rows = db.all(
      `SELECT s.* FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? AND s.removed_at IS NULL ORDER BY m.joined_at`,
      req.user.id,
    );
    const spaces = rows.map((s) => {
      const base = spacePerms(db, s, req.user.id);
      const channels = db.all("SELECT * FROM conversations WHERE space_id = ? AND type = 'channel' AND removed_at IS NULL", s.id);
      let unread = 0;
      for (const c of channels) {
        if (!(channelPerms(db, c, req.user.id, base).perms & P.VIEW_CHANNEL)) continue;
        const m = db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', c.id, req.user.id);
        if (m && !m.muted) unread += unreadCount(ctx, c, m, req.user.id);
      }
      return spaceSummary(ctx, s, { unread });
    });
    res.json({ spaces });
  }));

  r.get('/:id', h((req, res) => {
    const { space, sp } = load(req, { needMember: false });
    const member = !!sp.member;
    const categories = db.all('SELECT * FROM space_categories WHERE space_id = ? ORDER BY position', space.id);
    const channels = db
      .all("SELECT * FROM conversations WHERE space_id = ? AND type = 'channel' AND removed_at IS NULL ORDER BY position, created_at", space.id)
      .map((c) => {
        if (!member) return c.is_private ? null : channelView(ctx, c, req.user.id, 0, false);
        const perms = channelPerms(db, c, req.user.id, sp).perms;
        return perms & P.VIEW_CHANNEL ? channelView(ctx, c, req.user.id, perms, true) : null;
      })
      .filter(Boolean);
    const roles = db.all('SELECT * FROM space_roles WHERE space_id = ? ORDER BY position DESC', space.id).map(roleView);
    const myRoleIds = sp.roles.map((x) => x.id);
    res.json({
      space: spaceSummary(ctx, space, {
        isMember: member,
        isOwner: sp.owner,
        perms: sp.perms,
        myRoleIds,
        timeoutUntil: sp.member?.timeout_until > Date.now() ? sp.member.timeout_until : null,
        requested: !member && !!db.get("SELECT 1 FROM join_requests WHERE target_type = 'space' AND target_id = ? AND user_id = ?", space.id, req.user.id),
        planLimits: spacePlanOf(space),
      }),
      categories: categories.map((c) => ({ id: c.id, name: c.name, position: c.position })),
      channels,
      roles,
      permissionFlags: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { bit: v, label: PERM_LABELS[k] }])),
    });
  }));

  r.patch('/:id', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_SPACE);
    const b = req.body || {};
    const u = {};
    if (b.name !== undefined) u.name = str(b.name, 'Name', { min: 2, max: 80 });
    if (b.description !== undefined) u.description = str(b.description, 'Description', { max: 1000 });
    if (b.visibility !== undefined) u.visibility = oneOf(b.visibility, 'Visibility', ['public', 'private']);
    if (b.discoverable !== undefined) u.discoverable = bool(b.discoverable) ? 1 : 0;
    if ((u.visibility || space.visibility) === 'private') u.discoverable = 0;
    if (b.joinMode !== undefined) u.join_mode = oneOf(b.joinMode, 'Join mode', ['open', 'approval', 'invite']);
    if (b.topic !== undefined) u.topic = oneOf(b.topic, 'Topic', ['', ...EXPLORE_TOPICS]);
    if (b.language !== undefined) u.language = str(b.language, 'Language', { max: 8 });
    for (const [k, col] of [['iconFileId', 'icon_file_id'], ['bannerFileId', 'banner_file_id']]) {
      if (b[k] === undefined) continue;
      if (b[k]) {
        const f = db.get('SELECT * FROM files WHERE id = ? AND owner_id = ?', b[k], req.user.id);
        if (!f || f.category !== 'image') throw bad('Space images must be images from your files.');
        if (f.mime === 'image/gif' && space.plan !== 'pro' && col === 'banner_file_id') throw new HttpError(402, 'plan_required', 'Animated banners need Space Pro.');
      }
      u[col] = b[k] || null;
    }
    const cols = Object.keys(u);
    if (cols.length) db.run(`UPDATE spaces SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(u), space.id);
    spaceAudit(db, space.id, req.user.id, 'space.update', null, u);
    res.json({ space: spaceSummary(ctx, db.get('SELECT * FROM spaces WHERE id = ?', space.id)) });
  }));

  r.delete('/:id', h((req, res) => {
    const { space, sp } = load(req);
    if (!sp.owner) throw forbidden('Only the Space owner can delete it.');
    if (str(req.body?.confirmName, 'Confirmation') !== space.name) throw bad('Type the Space name to confirm.');
    db.run('UPDATE spaces SET removed_at = ? WHERE id = ?', Date.now(), space.id);
    db.run("UPDATE conversations SET removed_at = ? WHERE space_id = ?", Date.now(), space.id);
    res.json({ ok: true });
  }));

  r.post('/:id/transfer', h((req, res) => {
    const { space, sp } = load(req);
    if (!sp.owner) throw forbidden('Only the owner can transfer ownership.');
    const target = db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', space.id, req.body.userId);
    if (!target || target.user_id === req.user.id) throw bad('Choose another member of this Space.');
    db.run('UPDATE spaces SET owner_id = ? WHERE id = ?', target.user_id, space.id);
    // The previous owner keeps administrator access.
    const admin = db.get("SELECT id FROM space_roles WHERE space_id = ? AND system_key = 'admin'", space.id);
    if (admin) db.run('INSERT OR IGNORE INTO space_member_roles (space_id, user_id, role_id) VALUES (?,?,?)', space.id, req.user.id, admin.id);
    spaceAudit(db, space.id, req.user.id, 'space.transfer', target.user_id);
    notify(ctx, target.user_id, 'space_owner', { spaceId: space.id, spaceName: space.name });
    res.json({ ok: true });
  }));

  // ---- Joining ------------------------------------------------------------------------

  r.post('/:id/join', h((req, res) => {
    notRestricted(req);
    const space = db.get('SELECT * FROM spaces WHERE id = ? AND removed_at IS NULL', req.params.id);
    if (!space || space.visibility !== 'public') throw notFound('Space');
    if (db.get('SELECT 1 FROM space_bans WHERE space_id = ? AND user_id = ?', space.id, req.user.id)) throw forbidden('You are banned from this Space.');
    if (db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', space.id, req.user.id)) return res.json({ status: 'joined' });
    if (space.join_mode === 'open') {
      addSpaceMember(ctx, space, req.user.id);
      return res.json({ status: 'joined' });
    }
    if (space.join_mode === 'approval') {
      db.run("INSERT OR IGNORE INTO join_requests (target_type, target_id, user_id, message, created_at) VALUES ('space',?,?,?,?)",
        space.id, req.user.id, str(req.body.message, 'Message', { max: 300 }), Date.now());
      const managers = db.all('SELECT user_id FROM space_members WHERE space_id = ?', space.id)
        .filter((m) => spacePerms(db, space, m.user_id).perms & P.MANAGE_MEMBERS).slice(0, 20);
      for (const m of managers) notify(ctx, m.user_id, 'join_request', { spaceId: space.id, spaceName: space.name, from: miniUser(req.user) });
      return res.json({ status: 'requested' });
    }
    throw forbidden('This Space is invite-only.');
  }));

  r.post('/:id/leave', h((req, res) => {
    const { space, sp } = load(req);
    if (sp.owner) throw bad('Transfer ownership before leaving your Space.');
    db.run('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', space.id, req.user.id);
    db.run('DELETE FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, req.user.id);
    res.json({ ok: true });
  }));

  r.get('/:id/requests', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_MEMBERS);
    const rows = db.all("SELECT j.*, u.username, u.display_name, u.avatar_file_id FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.target_type = 'space' AND j.target_id = ? ORDER BY j.created_at", space.id);
    res.json({ requests: rows.map((j) => ({ user: { id: j.user_id, username: j.username, displayName: j.display_name, avatarFileId: j.avatar_file_id }, message: j.message, createdAt: j.created_at })) });
  }));

  r.post('/:id/requests/:userId', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_MEMBERS);
    const jr = db.get("SELECT * FROM join_requests WHERE target_type = 'space' AND target_id = ? AND user_id = ?", space.id, req.params.userId);
    if (!jr) throw notFound('Request');
    if (bool(req.body.approve)) {
      addSpaceMember(ctx, space, jr.user_id);
      notify(ctx, jr.user_id, 'join_approved', { spaceId: space.id, spaceName: space.name });
      spaceAudit(db, space.id, req.user.id, 'member.approve', jr.user_id);
    } else {
      db.run("DELETE FROM join_requests WHERE target_type = 'space' AND target_id = ? AND user_id = ?", space.id, jr.user_id);
    }
    res.json({ ok: true });
  }));

  // ---- Categories & channels ---------------------------------------------------------------

  r.post('/:id/categories', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_CHANNELS);
    const id = newId('cat');
    const pos = Number(db.value('SELECT COALESCE(MAX(position), -1) + 1 FROM space_categories WHERE space_id = ?', space.id));
    db.run('INSERT INTO space_categories (id, space_id, name, position) VALUES (?,?,?,?)', id, space.id, str(req.body.name, 'Category name', { min: 1, max: 40 }).toUpperCase(), pos);
    spaceAudit(db, space.id, req.user.id, 'category.create', id);
    res.status(201).json({ id });
  }));

  r.patch('/:id/categories/:cid', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_CHANNELS);
    const c = db.get('SELECT * FROM space_categories WHERE id = ? AND space_id = ?', req.params.cid, space.id);
    if (!c) throw notFound('Category');
    if (req.body.name !== undefined) db.run('UPDATE space_categories SET name = ? WHERE id = ?', str(req.body.name, 'Name', { min: 1, max: 40 }).toUpperCase(), c.id);
    if (req.body.position !== undefined) db.run('UPDATE space_categories SET position = ? WHERE id = ?', int(req.body.position, 'Position', { min: 0, max: 1000 }), c.id);
    res.json({ ok: true });
  }));

  r.delete('/:id/categories/:cid', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_CHANNELS);
    db.run('UPDATE conversations SET category_id = NULL WHERE category_id = ? AND space_id = ?', req.params.cid, space.id);
    db.run('DELETE FROM space_categories WHERE id = ? AND space_id = ?', req.params.cid, space.id);
    spaceAudit(db, space.id, req.user.id, 'category.delete', req.params.cid);
    res.json({ ok: true });
  }));

  r.post('/:id/channels', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_CHANNELS);
    const limit = spacePlanOf(space).channels;
    if (Number(db.value("SELECT COUNT(*) FROM conversations WHERE space_id = ? AND removed_at IS NULL", space.id)) >= limit) {
      throw new HttpError(402, 'plan_limit', `This Space can have up to ${limit} channels. Space Pro raises the limit.`);
    }
    const name = str(req.body.name, 'Channel name', { min: 1, max: 60 }).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    if (!name) throw bad('Channel name is not valid.');
    const type = oneOf(req.body.type, 'Channel type', CHANNEL_TYPES, 'text');
    const categoryId = req.body.categoryId || null;
    if (categoryId && !db.get('SELECT 1 FROM space_categories WHERE id = ? AND space_id = ?', categoryId, space.id)) throw bad('Unknown category.');
    const isPrivate = bool(req.body.isPrivate);
    const id = newId('cnv');
    const pos = Number(db.value('SELECT COALESCE(MAX(position), -1) + 1 FROM conversations WHERE space_id = ? AND category_id IS ?', space.id, categoryId));
    db.tx(() => {
      db.run(
        `INSERT INTO conversations (id, type, name, description, created_by, created_at, space_id, category_id, channel_type, is_private, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, 'channel', name, str(req.body.description, 'Description', { max: 500 }), req.user.id, Date.now(), space.id, categoryId, type, isPrivate ? 1 : 0, pos,
      );
      if (type === 'announcement') applyAnnouncementDefaults(db, id, space.id);
      if (isPrivate) {
        const everyone = db.get("SELECT id FROM space_roles WHERE space_id = ? AND system_key = 'everyone'", space.id);
        upsertOverride(db, id, 'role', everyone.id, 0, P.VIEW_CHANNEL, true);
        const roleIds = Array.isArray(req.body.allowedRoleIds) ? req.body.allowedRoleIds : [];
        for (const rid of roleIds) {
          if (db.get('SELECT 1 FROM space_roles WHERE id = ? AND space_id = ?', rid, space.id)) upsertOverride(db, id, 'role', rid, P.VIEW_CHANNEL, 0, true);
        }
        const memberIds = Array.isArray(req.body.allowedMemberIds) ? req.body.allowedMemberIds : [];
        for (const uid of memberIds) {
          if (db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', space.id, uid)) upsertOverride(db, id, 'member', uid, P.VIEW_CHANNEL, 0, true);
        }
        upsertOverride(db, id, 'member', req.user.id, P.VIEW_CHANNEL, 0, true);
      }
    });
    spaceAudit(db, space.id, req.user.id, 'channel.create', id, { name, type, isPrivate });
    res.status(201).json({ id });
  }));

  r.patch('/:id/channels/:cid', h((req, res) => {
    const { space, sp } = load(req);
    const c = loadChannel(space, req.params.cid);
    need(channelPerms(db, c, req.user.id, sp), P.MANAGE_CHANNELS);
    const b = req.body || {};
    const u = {};
    if (b.name !== undefined) u.name = str(b.name, 'Name', { min: 1, max: 60 }).toLowerCase().replace(/\s+/g, '-');
    if (b.description !== undefined) u.description = str(b.description, 'Description', { max: 500 });
    if (b.categoryId !== undefined) {
      if (b.categoryId && !db.get('SELECT 1 FROM space_categories WHERE id = ? AND space_id = ?', b.categoryId, space.id)) throw bad('Unknown category.');
      u.category_id = b.categoryId || null;
    }
    if (b.position !== undefined) u.position = int(b.position, 'Position', { min: 0, max: 1000 });
    if (b.slowModeSeconds !== undefined) u.slow_mode_seconds = int(b.slowModeSeconds, 'Slow mode', { min: 0, max: 21600 });
    if (b.isPrivate !== undefined) {
      u.is_private = bool(b.isPrivate) ? 1 : 0;
      const everyone = db.get("SELECT id FROM space_roles WHERE space_id = ? AND system_key = 'everyone'", space.id);
      const current = db.get("SELECT * FROM channel_overrides WHERE channel_id = ? AND target_type = 'role' AND target_id = ?", c.id, everyone.id) || { allow: 0, deny: 0 };
      const deny = u.is_private ? current.deny | P.VIEW_CHANNEL : current.deny & ~P.VIEW_CHANNEL;
      upsertOverride(db, c.id, 'role', everyone.id, current.allow & ~P.VIEW_CHANNEL, deny);
    }
    const cols = Object.keys(u);
    if (cols.length) db.run(`UPDATE conversations SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(u), c.id);
    spaceAudit(db, space.id, req.user.id, 'channel.update', c.id, u);
    res.json({ ok: true });
  }));

  r.delete('/:id/channels/:cid', h((req, res) => {
    const { space, sp } = load(req);
    const c = loadChannel(space, req.params.cid);
    need(sp, P.MANAGE_CHANNELS);
    db.run('UPDATE conversations SET removed_at = ? WHERE id = ?', Date.now(), c.id);
    spaceAudit(db, space.id, req.user.id, 'channel.delete', c.id, { name: c.name });
    res.json({ ok: true });
  }));

  r.get('/:id/channels/:cid/permissions', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const c = loadChannel(space, req.params.cid);
    const rows = db.all('SELECT * FROM channel_overrides WHERE channel_id = ?', c.id);
    res.json({
      overrides: rows.map((o) => ({
        targetType: o.target_type, targetId: o.target_id, allow: o.allow, deny: o.deny,
        target: o.target_type === 'role'
          ? roleView(db.get('SELECT * FROM space_roles WHERE id = ?', o.target_id) || { id: o.target_id, name: 'Deleted role' })
          : miniUser(db.get('SELECT * FROM users WHERE id = ?', o.target_id)),
      })),
    });
  }));

  r.put('/:id/channels/:cid/permissions', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const c = loadChannel(space, req.params.cid);
    const targetType = oneOf(req.body.targetType, 'Target type', ['role', 'member']);
    const targetId = String(req.body.targetId || '');
    if (targetType === 'role') {
      const role = db.get('SELECT * FROM space_roles WHERE id = ? AND space_id = ?', targetId, space.id);
      if (!role) throw bad('Unknown role.');
      if (!sp.owner && role.position >= sp.highest) throw forbidden('You can only edit roles below your highest role.');
    } else if (!db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', space.id, targetId)) {
      throw bad('Unknown member.');
    }
    const allow = int(req.body.allow ?? 0, 'allow', { min: 0, max: ALL_PERMS }) & ALL_PERMS & ~P.ADMINISTRATOR;
    const deny = int(req.body.deny ?? 0, 'deny', { min: 0, max: ALL_PERMS }) & ALL_PERMS & ~P.ADMINISTRATOR;
    if (!sp.owner && (allow & ~sp.perms)) throw forbidden('You cannot grant permissions you do not have.');
    if (!allow && !deny) db.run('DELETE FROM channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?', c.id, targetType, targetId);
    else upsertOverride(db, c.id, targetType, targetId, allow, deny);
    spaceAudit(db, space.id, req.user.id, 'channel.permissions', c.id, { targetType, targetId, allow, deny });
    res.json({ ok: true });
  }));

  // ---- Roles -----------------------------------------------------------------------------

  r.get('/:id/roles', h((req, res) => {
    const { space } = load(req);
    const roles = db.all('SELECT * FROM space_roles WHERE space_id = ? ORDER BY position DESC', space.id).map((ro) => ({
      ...roleView(ro),
      memberCount: ro.system_key === 'everyone'
        ? Number(db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ?', space.id))
        : Number(db.value('SELECT COUNT(*) FROM space_member_roles WHERE role_id = ?', ro.id)),
    }));
    res.json({ roles });
  }));

  r.post('/:id/roles', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const count = Number(db.value('SELECT COUNT(*) FROM space_roles WHERE space_id = ?', space.id));
    if (count >= spacePlanOf(space).roles) throw new HttpError(402, 'plan_limit', 'Role limit reached. Space Pro allows more roles.');
    let perms = int(req.body.permissions ?? DEFAULT_ROLE_PERMS.everyone, 'Permissions', { min: 0, max: ALL_PERMS });
    if (!sp.owner) perms &= sp.perms & ~P.ADMINISTRATOR;
    // New roles are placed just above @everyone and below the creator's highest role.
    const position = Math.min(sp.owner ? 15 : sp.highest - 1, int(req.body.position ?? 5, 'Position', { min: 1, max: 1000 }));
    if (position < 1) throw forbidden('You cannot create roles.');
    const id = newId('rol');
    db.run('INSERT INTO space_roles (id, space_id, name, color, position, permissions, created_at) VALUES (?,?,?,?,?,?,?)',
      id, space.id, str(req.body.name, 'Role name', { min: 1, max: 40 }), str(req.body.color, 'Color', { max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/ }), position, perms, Date.now());
    spaceAudit(db, space.id, req.user.id, 'role.create', id);
    res.status(201).json({ role: roleView(db.get('SELECT * FROM space_roles WHERE id = ?', id)) });
  }));

  r.patch('/:id/roles/:rid', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const role = db.get('SELECT * FROM space_roles WHERE id = ? AND space_id = ?', req.params.rid, space.id);
    if (!role) throw notFound('Role');
    if (!sp.owner && role.position >= sp.highest) throw forbidden('You can only edit roles below your highest role.');
    const u = {};
    if (req.body.name !== undefined && role.system_key !== 'everyone') u.name = str(req.body.name, 'Role name', { min: 1, max: 40 });
    if (req.body.color !== undefined) u.color = str(req.body.color, 'Color', { max: 9, pattern: /^#[0-9a-fA-F]{3,8}$/ });
    if (req.body.permissions !== undefined) {
      let perms = int(req.body.permissions, 'Permissions', { min: 0, max: ALL_PERMS });
      if (!sp.owner) {
        // Non-owners can only toggle permissions they hold themselves.
        const changed = perms ^ role.permissions;
        if (changed & ~sp.perms || changed & P.ADMINISTRATOR) throw forbidden('You cannot change permissions you do not have.');
      }
      if (role.system_key === 'everyone') perms &= ~P.ADMINISTRATOR;
      u.permissions = perms;
    }
    if (req.body.position !== undefined && role.system_key !== 'everyone') {
      const pos = int(req.body.position, 'Position', { min: 1, max: 1000 });
      if (!sp.owner && pos >= sp.highest) throw forbidden('Roles must stay below your highest role.');
      u.position = pos;
    }
    const cols = Object.keys(u);
    if (cols.length) db.run(`UPDATE space_roles SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(u), role.id);
    spaceAudit(db, space.id, req.user.id, 'role.update', role.id, u);
    res.json({ role: roleView(db.get('SELECT * FROM space_roles WHERE id = ?', role.id)) });
  }));

  r.delete('/:id/roles/:rid', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const role = db.get('SELECT * FROM space_roles WHERE id = ? AND space_id = ?', req.params.rid, space.id);
    if (!role) throw notFound('Role');
    if (role.system_key === 'everyone') throw bad('The @everyone role cannot be deleted.');
    if (!sp.owner && role.position >= sp.highest) throw forbidden('You can only delete roles below your highest role.');
    db.run('DELETE FROM space_roles WHERE id = ?', role.id);
    db.run("DELETE FROM channel_overrides WHERE target_type = 'role' AND target_id = ?", role.id);
    spaceAudit(db, space.id, req.user.id, 'role.delete', role.id, { name: role.name });
    res.json({ ok: true });
  }));

  // ---- Members ------------------------------------------------------------------------------

  r.get('/:id/members', h((req, res) => {
    const { space } = load(req);
    const q = String(req.query.q || '').trim();
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const offset = int(req.query.offset, 'offset', { min: 0, max: 100000, fallback: 0 });
    const rows = db.all(
      `SELECT u.*, m.joined_at, m.timeout_until FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = ? ${q ? "AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')" : ''}
       ORDER BY u.display_name COLLATE NOCASE LIMIT 100 OFFSET ?`,
      space.id, ...(q ? [like, like] : []), offset,
    );
    const members = rows.map((u) => ({
      user: publicProfile(ctx, u, req.user.id),
      joinedAt: u.joined_at,
      timeoutUntil: u.timeout_until > Date.now() ? u.timeout_until : null,
      isOwner: u.id === space.owner_id,
      roleIds: db.all('SELECT role_id FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, u.id).map((x) => x.role_id),
    }));
    res.json({ members, total: Number(db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ?', space.id)) });
  }));

  function targetMember(space, userId, sp, actorId) {
    const m = db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', space.id, userId);
    if (!m) throw notFound('Member');
    if (userId === space.owner_id) throw forbidden('The owner cannot be moderated.');
    if (userId !== actorId && !sp.owner) {
      const their = spacePerms(db, space, userId);
      if (their.highest >= sp.highest) throw forbidden('You can only act on members below your highest role.');
    }
    return m;
  }

  r.put('/:id/members/:userId/roles', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_ROLES);
    const m = targetMember(space, req.params.userId, sp, null);
    const roleIds = Array.isArray(req.body.roleIds) ? [...new Set(req.body.roleIds)] : [];
    const current = db.all('SELECT role_id FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, m.user_id).map((x) => x.role_id);
    const changed = [...roleIds.filter((x) => !current.includes(x)), ...current.filter((x) => !roleIds.includes(x))];
    for (const rid of changed) {
      const role = db.get('SELECT * FROM space_roles WHERE id = ? AND space_id = ?', rid, space.id);
      if (!role || role.system_key === 'everyone') throw bad('Unknown role.');
      // Assigning or removing administrators is reserved for the owner.
      if (!sp.owner && (role.position >= sp.highest || role.permissions & P.ADMINISTRATOR)) {
        throw forbidden(`Only the owner can assign or remove "${role.name}".`);
      }
    }
    db.tx(() => {
      db.run('DELETE FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, m.user_id);
      for (const rid of roleIds) db.run('INSERT INTO space_member_roles (space_id, user_id, role_id) VALUES (?,?,?)', space.id, m.user_id, rid);
    });
    spaceAudit(db, space.id, req.user.id, 'member.roles', m.user_id, { roleIds });
    res.json({ ok: true });
  }));

  r.post('/:id/members/:userId/timeout', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_MEMBERS);
    const m = targetMember(space, req.params.userId, sp, req.user.id);
    const minutes = int(req.body.minutes, 'Minutes', { min: 0, max: 60 * 24 * 28 });
    const until = minutes ? Date.now() + minutes * 60_000 : null;
    db.run('UPDATE space_members SET timeout_until = ? WHERE space_id = ? AND user_id = ?', until, space.id, m.user_id);
    logSpaceMod(db, req.user.id, space.id, 'user', m.user_id, minutes ? `timeout:${minutes}m` : 'timeout_cleared', req.body.reason, until);
    if (minutes) notify(ctx, m.user_id, 'moderation', { spaceId: space.id, spaceName: space.name, action: 'timeout', until, reason: req.body.reason || null });
    res.json({ ok: true, until });
  }));

  r.delete('/:id/members/:userId', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_MEMBERS);
    const m = targetMember(space, req.params.userId, sp, req.user.id);
    db.run('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', space.id, m.user_id);
    db.run('DELETE FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, m.user_id);
    logSpaceMod(db, req.user.id, space.id, 'user', m.user_id, 'kick', req.body?.reason);
    res.json({ ok: true });
  }));

  r.get('/:id/bans', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.BAN_MEMBERS);
    const rows = db.all('SELECT b.*, u.username, u.display_name FROM space_bans b JOIN users u ON u.id = b.user_id WHERE b.space_id = ? ORDER BY b.created_at DESC', space.id);
    res.json({ bans: rows.map((b) => ({ user: { id: b.user_id, username: b.username, displayName: b.display_name }, reason: b.reason, createdAt: b.created_at })) });
  }));

  r.post('/:id/bans', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.BAN_MEMBERS);
    const userId = String(req.body.userId || '');
    if (userId === req.user.id || userId === space.owner_id) throw bad('That member cannot be banned.');
    if (db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', space.id, userId)) targetMember(space, userId, sp, req.user.id);
    const reason = str(req.body.reason, 'Reason', { max: 500 });
    db.run('INSERT OR REPLACE INTO space_bans (space_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)', space.id, userId, reason, req.user.id, Date.now());
    db.run('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', space.id, userId);
    db.run('DELETE FROM space_member_roles WHERE space_id = ? AND user_id = ?', space.id, userId);
    logSpaceMod(db, req.user.id, space.id, 'user', userId, 'ban', reason);
    res.json({ ok: true });
  }));

  r.delete('/:id/bans/:userId', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.BAN_MEMBERS);
    db.run('DELETE FROM space_bans WHERE space_id = ? AND user_id = ?', space.id, req.params.userId);
    logSpaceMod(db, req.user.id, space.id, 'user', req.params.userId, 'unban');
    res.json({ ok: true });
  }));

  // ---- Invites -------------------------------------------------------------------------------

  r.get('/:id/invites', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.CREATE_INVITES);
    const all = sp.perms & P.MANAGE_INVITES;
    const rows = db.all(
      `SELECT * FROM invites WHERE target_type = 'space' AND target_id = ? AND revoked_at IS NULL ${all ? '' : 'AND created_by = ?'} ORDER BY created_at DESC`,
      space.id, ...(all ? [] : [req.user.id]),
    );
    res.json({ invites: rows.map(inviteView) });
  }));

  r.post('/:id/invites', h((req, res) => {
    notRestricted(req);
    const { space, sp } = load(req);
    need(sp, P.CREATE_INVITES, 'You cannot create invites in this Space.');
    if (req.body.vanityCode) need(sp, P.MANAGE_INVITES, 'Only invite managers can create vanity links.');
    const invite = createInvite(db, 'space', space.id, req.user.id, req.body, { allowVanity: space.plan === 'pro' });
    spaceAudit(db, space.id, req.user.id, 'invite.create', invite.code);
    res.status(201).json({ invite: inviteView(invite) });
  }));

  // ---- Space moderation: reports, audit, analytics ------------------------------------------

  r.get('/:id/reports', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MODERATE);
    const status = oneOf(req.query.status, 'status', ['open', 'reviewing', 'escalated', 'resolved', 'dismissed', 'all'], 'open');
    const rows = db.all(
      `SELECT r.*, u.username AS reporter_username FROM reports r JOIN users u ON u.id = r.reporter_id
       WHERE r.space_id = ? ${status === 'all' ? '' : 'AND r.status = ?'} ORDER BY r.created_at DESC LIMIT 200`,
      space.id, ...(status === 'all' ? [] : [status]),
    );
    res.json({ reports: rows.map((x) => ({ ...reportRow(x) })) });
  }));

  r.patch('/:id/reports/:rid', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MODERATE);
    const rep = db.get('SELECT * FROM reports WHERE id = ? AND space_id = ?', req.params.rid, space.id);
    if (!rep) throw notFound('Report');
    const status = oneOf(req.body.status, 'Status', ['reviewing', 'resolved', 'dismissed', 'escalated']);
    db.run('UPDATE reports SET status = ?, resolution = ?, assigned_to = ?, updated_at = ? WHERE id = ?',
      status, str(req.body.resolution, 'Resolution', { max: 1000 }) || rep.resolution, req.user.id, Date.now(), rep.id);
    logSpaceMod(db, req.user.id, space.id, 'report', rep.id, `report_${status}`, req.body.resolution);
    res.json({ ok: true });
  }));

  r.get('/:id/moderation', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MODERATE);
    const rows = db.all(
      `SELECT a.*, u.username AS actor_username FROM moderation_actions a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.scope = ? ORDER BY a.created_at DESC LIMIT 200`, `space:${space.id}`,
    );
    res.json({ actions: rows.map((a) => ({ id: a.id, actor: a.actor_username, targetType: a.target_type, targetId: a.target_id, action: a.action, reason: a.reason, createdAt: a.created_at, expiresAt: a.expires_at })) });
  }));

  r.get('/:id/audit', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_SPACE);
    const since = Date.now() - spacePlanOf(space).auditDays * 86400_000;
    const rows = db.all(
      `SELECT a.*, u.username FROM space_audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.space_id = ? AND a.created_at > ?
       ORDER BY a.created_at DESC LIMIT 300`, space.id, since,
    );
    res.json({ entries: rows.map((a) => ({ id: a.id, actor: a.username, action: a.action, target: a.target, detail: a.detail ? JSON.parse(a.detail) : null, createdAt: a.created_at })), retentionDays: spacePlanOf(space).auditDays });
  }));

  r.get('/:id/analytics', h((req, res) => {
    const { space, sp } = load(req);
    need(sp, P.MANAGE_SPACE);
    if (space.plan !== 'pro') throw new HttpError(402, 'plan_required', 'Space analytics are part of Space Pro.');
    const since = Date.now() - 30 * 86400_000;
    const daily = db.all(
      `SELECT CAST(m.created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS messages, COUNT(DISTINCT m.sender_id) AS senders
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.space_id = ? AND m.created_at > ? GROUP BY day ORDER BY day`,
      space.id, since,
    );
    const channels = db.all(
      `SELECT c.id, c.name, COUNT(m.id) AS messages FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id AND m.created_at > ?
       WHERE c.space_id = ? AND c.removed_at IS NULL GROUP BY c.id ORDER BY messages DESC LIMIT 20`, since, space.id,
    );
    const joins = Number(db.value('SELECT COUNT(*) FROM space_members WHERE space_id = ? AND joined_at > ?', space.id, since));
    res.json({ daily: daily.map((d) => ({ date: d.day * 86400000, messages: d.messages, senders: d.senders })), channels, joins30d: joins });
  }));

  return r;
}

export function reportRow(x) {
  return {
    id: x.id, reporterId: x.reporter_id, reporter: x.reporter_username, targetType: x.target_type, targetId: x.target_id,
    reason: x.reason, details: x.details, evidence: JSON.parse(x.evidence || '{}'), status: x.status, resolution: x.resolution,
    spaceId: x.space_id, conversationId: x.conversation_id, assignedTo: x.assigned_to, createdAt: x.created_at, updatedAt: x.updated_at,
  };
}

function logSpaceMod(db, actorId, spaceId, targetType, targetId, action, reason = null, expiresAt = null) {
  db.run(
    `INSERT INTO moderation_actions (id, actor_id, scope, target_type, target_id, action, reason, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    newId('mod'), actorId, `space:${spaceId}`, targetType, targetId, action, reason || null, expiresAt, Date.now(),
  );
}

export function upsertOverride(db, channelId, targetType, targetId, allow, deny, merge = false) {
  if (merge) {
    const cur = db.get('SELECT * FROM channel_overrides WHERE channel_id = ? AND target_type = ? AND target_id = ?', channelId, targetType, targetId);
    if (cur) {
      allow = (cur.allow | allow) & ~deny;
      deny = (cur.deny | deny) & ~allow;
    }
  }
  db.run(
    `INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?,?,?,?,?)
     ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
    channelId, targetType, targetId, allow, deny,
  );
}

/** Announcement channels: everyone reads; only moderators/admins create posts. */
export function applyAnnouncementDefaults(db, channelId, spaceId) {
  const roles = db.all("SELECT id, system_key FROM space_roles WHERE space_id = ? AND system_key IS NOT NULL", spaceId);
  for (const r of roles) {
    if (r.system_key === 'everyone') upsertOverride(db, channelId, 'role', r.id, 0, P.SEND_MESSAGES | P.SEND_MEDIA | P.UPLOAD_FILES | P.CREATE_THREADS, true);
    else upsertOverride(db, channelId, 'role', r.id, P.SEND_MESSAGES | P.SEND_MEDIA | P.UPLOAD_FILES, 0, true);
  }
}

export { systemMessage, lastMessagePreview };
