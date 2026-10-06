import { Router } from 'express';
import { h, notFound, forbidden, HttpError } from '../lib/http.js';
import { requireUser, notRestricted } from '../lib/auth.js';
import { spacePerms, P, GROUP_ROLE_RANK } from '../lib/perms.js';
import { miniUser } from '../lib/users.js';
import { systemMessage } from '../lib/messaging.js';
import { addGroupMember } from './conversations.js';
import { addSpaceMember, spaceSummary } from './spaces.js';
import { planOf } from './me.js';

export default function inviteRoutes(ctx) {
  const r = Router();
  const { db, limiter } = ctx;
  r.use(requireUser);

  function load(req) {
    limiter.check(`invite:${req.user.id}`, 60, 60_000);
    const inv = db.get('SELECT * FROM invites WHERE code = ?', String(req.params.code || '').toUpperCase());
    if (!inv) throw notFound('Invite');
    const invalid = inv.revoked_at ? 'revoked' : inv.expires_at && inv.expires_at < Date.now() ? 'expired'
      : inv.max_uses && inv.uses >= inv.max_uses ? 'used_up' : null;
    const target = inv.target_type === 'space'
      ? db.get('SELECT * FROM spaces WHERE id = ? AND removed_at IS NULL', inv.target_id)
      : db.get("SELECT * FROM conversations WHERE id = ? AND type = 'group' AND removed_at IS NULL", inv.target_id);
    if (!target) throw notFound('Invite');
    return { inv, target, invalid };
  }

  r.get('/:code', h((req, res) => {
    const { inv, target, invalid } = load(req);
    const inviter = miniUser(db.get('SELECT * FROM users WHERE id = ?', inv.created_by));
    if (inv.target_type === 'space') {
      return res.json({
        type: 'space', invalid, inviter, space: spaceSummary(ctx, target),
        isMember: !!db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', target.id, req.user.id),
      });
    }
    res.json({
      type: 'group', invalid, inviter,
      group: {
        id: target.id, name: target.name, description: target.description, avatarFileId: target.avatar_file_id,
        memberCount: Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', target.id)),
      },
      isMember: !!db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', target.id, req.user.id),
    });
  }));

  r.post('/:code/join', h((req, res) => {
    notRestricted(req);
    const { inv, target, invalid } = load(req);
    if (invalid) throw new HttpError(410, `invite_${invalid}`, 'This invite is no longer valid.');
    if (inv.target_type === 'space') {
      if (db.get('SELECT 1 FROM space_bans WHERE space_id = ? AND user_id = ?', target.id, req.user.id)) throw forbidden('You are banned from this Space.');
      if (!db.get('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?', target.id, req.user.id)) {
        addSpaceMember(ctx, target, req.user.id);
        db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
      }
      return res.json({ type: 'space', id: target.id });
    }
    if (db.get('SELECT 1 FROM conversation_bans WHERE conversation_id = ? AND user_id = ?', target.id, req.user.id)) throw forbidden('You are banned from this group.');
    if (!db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', target.id, req.user.id)) {
      const owner = db.get("SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.role = 'owner'", target.id);
      const count = Number(db.value('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?', target.id));
      if (count >= planOf(owner || {}).groupMembers) throw forbidden('This group is full.');
      addGroupMember(ctx, target, req.user.id);
      db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
      systemMessage(ctx, target, { event: 'member_joined', user: miniUser(req.user), via: 'invite' }, req.user.id);
    }
    res.json({ type: 'group', id: target.id });
  }));

  r.delete('/:code', h((req, res) => {
    const { inv, target } = load(req);
    let allowed = inv.created_by === req.user.id;
    if (!allowed && inv.target_type === 'space') allowed = !!(spacePerms(db, target, req.user.id).perms & P.MANAGE_INVITES);
    if (!allowed && inv.target_type === 'group') {
      const m = db.get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', target.id, req.user.id);
      allowed = (GROUP_ROLE_RANK[m?.role] ?? -1) >= 1;
    }
    if (!allowed) throw forbidden();
    db.run('UPDATE invites SET revoked_at = ? WHERE code = ?', Date.now(), inv.code);
    res.json({ ok: true });
  }));

  return r;
}
