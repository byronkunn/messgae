import { formatAccountId, newId } from './crypto.js';
import { parseJson } from './http.js';
import { siteCaps } from './perms.js';

export const DEFAULT_PRIVACY = {
  onlineStatus: 'everyone', // everyone | contacts | nobody
  lastSeen: 'contacts',
  whoCanMessage: 'everyone', // everyone | contacts | mutual_groups | nobody
  whoCanAddToGroups: 'contacts', // everyone | contacts | nobody
  readReceipts: true,
  typingIndicators: true,
  joinedSpaces: 'contacts',
  mutualGroups: 'everyone',
  profileLinks: 'everyone',
  discoverable: true, // appear in people search / Explore
};

export const PRIVACY_OPTIONS = {
  onlineStatus: ['everyone', 'contacts', 'nobody'],
  lastSeen: ['everyone', 'contacts', 'nobody'],
  whoCanMessage: ['everyone', 'contacts', 'mutual_groups', 'nobody'],
  whoCanAddToGroups: ['everyone', 'contacts', 'nobody'],
  joinedSpaces: ['everyone', 'contacts', 'nobody'],
  mutualGroups: ['everyone', 'contacts', 'nobody'],
  profileLinks: ['everyone', 'contacts', 'nobody'],
  readReceipts: [true, false],
  typingIndicators: [true, false],
  discoverable: [true, false],
};

export const privacyOf = (user) => ({ ...DEFAULT_PRIVACY, ...parseJson(user.privacy, {}) });

export const isContact = (db, ownerId, viewerId) =>
  !!db.get('SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?', ownerId, viewerId);

export function audienceAllows(db, level, owner, viewerId) {
  if (!viewerId) return level === 'everyone';
  if (owner.id === viewerId) return true;
  if (level === 'everyone') return true;
  if (level === 'contacts') return isContact(db, owner.id, viewerId);
  return false;
}

export function mutualGroupIds(db, a, b) {
  return db.all(
    `SELECT c.id, c.name FROM conversations c
     JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
     JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
     WHERE c.type = 'group' AND c.removed_at IS NULL LIMIT 50`,
    a, b,
  );
}

/** Whether `sender` may start/continue a DM with `recipient`, per the recipient's privacy settings. */
export function canMessage(db, sender, recipient) {
  if (sender.id === recipient.id) return false;
  const p = privacyOf(recipient);
  if (p.whoCanMessage === 'everyone') return true;
  if (p.whoCanMessage === 'nobody') return false;
  if (p.whoCanMessage === 'contacts') return isContact(db, recipient.id, sender.id);
  if (p.whoCanMessage === 'mutual_groups') {
    return isContact(db, recipient.id, sender.id) || mutualGroupIds(db, sender.id, recipient.id).length > 0 ||
      !!db.get(
        `SELECT 1 FROM space_members a JOIN space_members b ON a.space_id = b.space_id
         WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`, sender.id, recipient.id,
      );
  }
  return false;
}

/** Profile as seen by `viewerId`, with the owner's privacy choices applied. */
export function publicProfile(ctx, user, viewerId) {
  const { db, hub } = ctx;
  if (!user) return null;
  const p = privacyOf(user);
  const self = viewerId === user.id;
  const out = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio,
    statusText: user.status_text,
    statusEmoji: user.status_emoji,
    avatarFileId: user.avatar_file_id,
    bannerFileId: user.banner_file_id,
    plan: user.plan,
    createdAt: user.created_at,
    staffBadge: user.site_role !== 'user' ? user.site_role : null,
    state: user.state === 'active' ? undefined : user.state === 'banned' || user.state === 'suspended' ? 'unavailable' : undefined,
  };
  if (audienceAllows(db, p.profileLinks, user, viewerId)) out.links = parseJson(user.links, []);
  if (audienceAllows(db, p.onlineStatus, user, viewerId)) out.online = hub?.isOnline(user.id) ?? false;
  if (audienceAllows(db, p.lastSeen, user, viewerId)) out.lastSeenAt = user.last_seen_at;
  if (viewerId && !self) {
    out.isContact = isContact(db, viewerId, user.id);
    out.blocked = !!db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', viewerId, user.id);
    out.muted = !!db.get('SELECT 1 FROM user_mutes WHERE user_id = ? AND muted_id = ?', viewerId, user.id);
    out.canMessage = !out.blocked && canMessage(db, { id: viewerId }, user) &&
      !db.get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', user.id, viewerId);
    if (audienceAllows(db, p.mutualGroups, user, viewerId)) out.mutualGroups = mutualGroupIds(db, viewerId, user.id);
  }
  if (audienceAllows(db, p.joinedSpaces, user, viewerId)) {
    out.spaces = db.all(
      `SELECT s.id, s.name, s.icon_file_id AS iconFileId FROM spaces s JOIN space_members m ON m.space_id = s.id
       WHERE m.user_id = ? AND s.removed_at IS NULL AND (s.visibility = 'public' OR ? = 1) LIMIT 50`,
      user.id, self ? 1 : 0,
    );
  }
  return out;
}

/** The signed-in user's own account view. */
export function selfView(ctx, user) {
  return {
    ...publicProfile(ctx, user, user.id),
    accountId: formatAccountId(user.account_id),
    privacy: privacyOf(user),
    siteRole: user.site_role,
    capabilities: [...siteCaps(user)],
    evidenceAccess: !!user.evidence_access,
    totpEnabled: !!user.totp_enabled,
    recoveryRotatedAt: user.recovery_rotated_at,
    state: user.state,
    stateUntil: user.state_until,
    stateReason: user.state === 'active' ? null : user.state_reason,
  };
}

/** Creates a notification row and pushes it to the user's live sockets. */
export function notify(ctx, userId, type, data = {}) {
  const n = { id: newId('ntf'), userId, type, data, createdAt: Date.now(), readAt: null };
  ctx.db.run(
    'INSERT INTO notifications (id, user_id, type, data, created_at) VALUES (?,?,?,?,?)',
    n.id, userId, type, JSON.stringify(data), n.createdAt,
  );
  ctx.hub?.toUser(userId, { type: 'notification', notification: n });
  return n;
}

export const userById = (db, id) => db.get('SELECT * FROM users WHERE id = ?', id);

export function miniUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, avatarFileId: u.avatar_file_id };
}
