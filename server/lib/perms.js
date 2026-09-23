import { notFound, forbidden } from './http.js';

// ---------------------------------------------------------------------------
// Site roles (platform staff). Space roles are completely separate: being a Space
// Admin never grants any site capability.

export const SITE_ROLES = ['user', 'site_moderator', 'site_admin', 'super_admin'];
const RANK = { user: 0, site_moderator: 1, site_admin: 2, super_admin: 3 };
export const siteRank = (role) => RANK[role] ?? 0;

const MOD_CAPS = [
  'admin.access', 'reports.review', 'users.view', 'users.warn', 'users.restrict', 'users.suspend',
  'content.remove', 'explore.manage', 'reports.escalate', 'conversations.meta',
];
const ADMIN_CAPS = [
  ...MOD_CAPS, 'users.ban', 'users.security', 'analytics.view', 'files.inspect', 'spaces.remove',
  'billing.view', 'system.view', 'audit.view', 'data.export', 'users.plan',
];
const SUPER_CAPS = [...ADMIN_CAPS, 'staff.manage', 'evidence.grant', 'audit.verify'];
const CAPS = {
  user: new Set(),
  site_moderator: new Set(MOD_CAPS),
  site_admin: new Set(ADMIN_CAPS),
  super_admin: new Set(SUPER_CAPS),
};

/** Evidence Access is a separate grant on top of the role (only selected Admins/Super Admins). */
export function siteCaps(user) {
  const caps = new Set(CAPS[user?.site_role] || []);
  if (user?.evidence_access && siteRank(user.site_role) >= RANK.site_admin) caps.add('evidence.access');
  return caps;
}

export const hasCap = (user, cap) => siteCaps(user).has(cap);

// Actions that need a fresh second-factor check ("privileged session").
export const ELEVATED_CAPS = new Set([
  'evidence.access', 'users.ban', 'users.security', 'staff.manage', 'evidence.grant', 'data.export',
]);

// ---------------------------------------------------------------------------
// Space permissions (bit flags).

export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  SEND_MEDIA: 1 << 2,
  UPLOAD_FILES: 1 << 3,
  CREATE_FILE_LINKS: 1 << 4,
  ADD_REACTIONS: 1 << 5,
  CREATE_THREADS: 1 << 6,
  REPLY_THREADS: 1 << 7,
  PIN_MESSAGES: 1 << 8,
  DELETE_MESSAGES: 1 << 9,
  MENTION_EVERYONE: 1 << 10,
  CREATE_INVITES: 1 << 11,
  MANAGE_MEMBERS: 1 << 12,
  MANAGE_MESSAGES: 1 << 13,
  MANAGE_CHANNELS: 1 << 14,
  MANAGE_ROLES: 1 << 15,
  MODERATE: 1 << 16,
  BAN_MEMBERS: 1 << 17,
  MANAGE_INVITES: 1 << 18,
  MANAGE_SPACE: 1 << 19,
  ADMINISTRATOR: 1 << 20,
};
export const ALL_PERMS = Object.values(P).reduce((a, b) => a | b, 0);

export const PERM_LABELS = {
  VIEW_CHANNEL: 'View channel', SEND_MESSAGES: 'Send messages', SEND_MEDIA: 'Send media', UPLOAD_FILES: 'Upload files',
  CREATE_FILE_LINKS: 'Create file links', ADD_REACTIONS: 'Add reactions', CREATE_THREADS: 'Create threads',
  REPLY_THREADS: 'Reply to threads', PIN_MESSAGES: 'Pin messages', DELETE_MESSAGES: "Delete others' messages",
  MENTION_EVERYONE: 'Mention everyone', CREATE_INVITES: 'Create invites', MANAGE_MEMBERS: 'Manage members (kick, timeout)',
  MANAGE_MESSAGES: 'Manage messages & threads', MANAGE_CHANNELS: 'Manage channels & categories', MANAGE_ROLES: 'Manage roles & permissions',
  MODERATE: 'Moderate (reports, slow mode, lock)', BAN_MEMBERS: 'Ban members', MANAGE_INVITES: 'Manage invites',
  MANAGE_SPACE: 'Manage Space settings', ADMINISTRATOR: 'Administrator (all permissions)',
};

export const DEFAULT_ROLE_PERMS = {
  everyone:
    P.VIEW_CHANNEL | P.SEND_MESSAGES | P.SEND_MEDIA | P.UPLOAD_FILES | P.CREATE_FILE_LINKS | P.ADD_REACTIONS |
    P.CREATE_THREADS | P.REPLY_THREADS | P.CREATE_INVITES,
};
DEFAULT_ROLE_PERMS.moderator =
  DEFAULT_ROLE_PERMS.everyone | P.PIN_MESSAGES | P.DELETE_MESSAGES | P.MANAGE_MESSAGES | P.MANAGE_MEMBERS |
  P.MODERATE | P.MENTION_EVERYONE;
DEFAULT_ROLE_PERMS.admin = ALL_PERMS;

const TIMEOUT_STRIPPED =
  P.SEND_MESSAGES | P.SEND_MEDIA | P.UPLOAD_FILES | P.ADD_REACTIONS | P.CREATE_THREADS | P.REPLY_THREADS | P.CREATE_FILE_LINKS;

/** Base (Space-wide) permissions for a user. */
export function spacePerms(db, spaceOrId, userId) {
  const space = typeof spaceOrId === 'string' ? db.get('SELECT * FROM spaces WHERE id = ?', spaceOrId) : spaceOrId;
  if (!space || space.removed_at) return { space, member: false, owner: false, perms: 0, roles: [], highest: -1 };
  const member = db.get('SELECT * FROM space_members WHERE space_id = ? AND user_id = ?', space.id, userId);
  if (!member) return { space, member: null, owner: false, perms: 0, roles: [], highest: -1 };
  const owner = space.owner_id === userId;
  const roles = db.all(
    `SELECT r.* FROM space_roles r
     LEFT JOIN space_member_roles mr ON mr.role_id = r.id AND mr.user_id = ?
     WHERE r.space_id = ? AND (r.system_key = 'everyone' OR mr.user_id IS NOT NULL)
     ORDER BY r.position DESC`,
    userId, space.id,
  );
  let perms = roles.reduce((acc, r) => acc | r.permissions, 0);
  if (owner || perms & P.ADMINISTRATOR) perms = ALL_PERMS;
  const highest = owner ? Number.MAX_SAFE_INTEGER : Math.max(0, ...roles.map((r) => r.position));
  return { space, member, owner, perms, roles, highest };
}

/** Channel permissions: Space base permissions with channel overrides applied (everyone → roles → member). */
export function channelPerms(db, channel, userId, base = null) {
  const sp = base || spacePerms(db, channel.space_id, userId);
  if (!sp.member) return { ...sp, perms: 0 };
  if (sp.owner || sp.perms & P.ADMINISTRATOR) return { ...sp, perms: ALL_PERMS };
  let perms = sp.perms;
  const overrides = db.all('SELECT * FROM channel_overrides WHERE channel_id = ?', channel.id);
  const everyone = sp.roles.find((r) => r.system_key === 'everyone');
  const byTarget = new Map(overrides.map((o) => [`${o.target_type}:${o.target_id}`, o]));
  const ev = everyone && byTarget.get(`role:${everyone.id}`);
  if (ev) perms = (perms & ~ev.deny) | ev.allow;
  let allow = 0, deny = 0;
  for (const r of sp.roles) {
    if (r.system_key === 'everyone') continue;
    const o = byTarget.get(`role:${r.id}`);
    if (o) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  perms = (perms & ~deny) | allow;
  const mo = byTarget.get(`member:${userId}`);
  if (mo) perms = (perms & ~mo.deny) | mo.allow;
  if (!(perms & P.VIEW_CHANNEL)) perms = 0;
  if (sp.member.timeout_until && sp.member.timeout_until > Date.now()) perms &= ~TIMEOUT_STRIPPED;
  return { ...sp, perms };
}

// ---------------------------------------------------------------------------
// Unified conversation access: DMs, groups and channels.

const NONE = {
  view: false, send: false, sendMedia: false, uploadFiles: false, createLinks: false, react: false,
  createThreads: false, replyThreads: false, pin: false, deleteAny: false, manageMessages: false,
  mentionEveryone: false, createInvites: false, manageMembers: false, manageChannel: false, moderate: false, ban: false,
};

function fromBits(bits) {
  return {
    view: !!(bits & P.VIEW_CHANNEL),
    send: !!(bits & P.SEND_MESSAGES),
    sendMedia: !!(bits & P.SEND_MEDIA),
    uploadFiles: !!(bits & P.UPLOAD_FILES),
    createLinks: !!(bits & P.CREATE_FILE_LINKS),
    react: !!(bits & P.ADD_REACTIONS),
    createThreads: !!(bits & P.CREATE_THREADS),
    replyThreads: !!(bits & P.REPLY_THREADS),
    pin: !!(bits & P.PIN_MESSAGES),
    deleteAny: !!(bits & P.DELETE_MESSAGES),
    manageMessages: !!(bits & P.MANAGE_MESSAGES),
    mentionEveryone: !!(bits & P.MENTION_EVERYONE),
    createInvites: !!(bits & P.CREATE_INVITES),
    manageMembers: !!(bits & P.MANAGE_MEMBERS),
    manageChannel: !!(bits & P.MANAGE_CHANNELS),
    moderate: !!(bits & P.MODERATE),
    ban: !!(bits & P.BAN_MEMBERS),
  };
}

export const GROUP_ROLE_RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };

export function groupCan(conv, member) {
  if (!member) return { ...NONE };
  const s = parseSettings(conv.settings);
  const rank = GROUP_ROLE_RANK[member.role] ?? 0;
  const staff = rank >= 1;
  const admin = rank >= 2;
  const timedOut = member.timeout_until && member.timeout_until > Date.now();
  const canPost = !timedOut && (staff || s.membersCanSend !== false);
  return {
    view: true,
    send: canPost,
    sendMedia: canPost && (staff || s.membersCanSendMedia !== false),
    uploadFiles: canPost && (staff || s.membersCanSendMedia !== false),
    createLinks: canPost,
    react: !timedOut,
    createThreads: false,
    replyThreads: false,
    pin: staff || !!s.membersCanPin,
    deleteAny: staff,
    manageMessages: staff,
    mentionEveryone: staff || !!s.membersCanMentionAll,
    createInvites: staff || s.membersCanInvite !== false,
    manageMembers: staff,
    manageChannel: admin,
    moderate: staff,
    ban: staff,
  };
}

export function parseSettings(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

export const isBlockedEitherWay = (db, a, b) =>
  !!db.get('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', a, b, b, a);

/**
 * Resolves what `userId` may do in a conversation. Throws 404 when the user cannot
 * see it at all (so existence is not leaked).
 */
export function conversationAccess(db, userId, convId, { allowMissing = false } = {}) {
  const conv = db.get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv || conv.removed_at) {
    if (allowMissing) return null;
    throw notFound('Conversation');
  }
  let can = { ...NONE };
  let member = db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, userId);
  let extra = {};

  if (conv.type === 'dm') {
    if (member) {
      const other = db.get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?', conv.id, userId);
      const blocked = other ? isBlockedEitherWay(db, userId, other.user_id) : false;
      can = { ...NONE, view: true, send: !blocked, sendMedia: !blocked, uploadFiles: !blocked, createLinks: !blocked, react: !blocked, pin: true };
      extra.otherUserId = other?.user_id;
      extra.blocked = blocked;
    }
  } else if (conv.type === 'group') {
    const banned = db.get('SELECT 1 FROM conversation_bans WHERE conversation_id = ? AND user_id = ?', conv.id, userId);
    if (member && !banned) can = groupCan(conv, member);
    else if (!banned && conv.visibility === 'public' && !conv.explore_removed) extra.preview = true;
  } else if (conv.type === 'channel') {
    const cp = channelPerms(db, conv, userId);
    can = fromBits(cp.perms);
    extra.space = cp.space;
    extra.spacePerms = cp.perms;
    extra.spaceOwner = cp.owner;
    if (cp.member && can.view && !member) {
      // Per-user state (read position, mute) for channels is created lazily.
      db.run(
        'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?,?,?,?,?)',
        conv.id, userId, 'member', Date.now(), Date.now(),
      );
      member = db.get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, userId);
    }
    if (!can.view && cp.space?.visibility === 'public' && !conv.is_private && !cp.member) extra.preview = true;
  }

  if (conv.locked && !can.moderate) {
    can.send = can.sendMedia = can.uploadFiles = can.createThreads = can.replyThreads = false;
  }
  if (!can.view && !extra.preview) {
    if (allowMissing) return null;
    throw notFound('Conversation');
  }
  return { conv, member, can, ...extra };
}

export function requireCan(access, key, message) {
  if (!access.can[key]) throw forbidden(message);
}
