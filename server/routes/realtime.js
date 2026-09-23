import { conversationAccess } from '../lib/perms.js';
import { privacyOf } from '../lib/users.js';
import { recipientsOf } from '../lib/messaging.js';

/** Client → server socket events. */
export function registerRealtimeHandlers(ctx) {
  const { db, hub, limiter } = ctx;

  hub.on('typing', (ws, msg) => {
    if (!limiter.hit(`typing:${ws.userId}`, 30, 10_000).allowed) return;
    const user = db.get('SELECT * FROM users WHERE id = ?', ws.userId);
    if (!user || !privacyOf(user).typingIndicators) return;
    const a = conversationAccess(db, ws.userId, String(msg.conversationId || ''), { allowMissing: true });
    if (!a || !a.can.send && !a.can.replyThreads) return;
    const targets = recipientsOf(ctx, a.conv).filter((id) => id !== ws.userId);
    hub.toUsers(targets, {
      type: 'typing', conversationId: a.conv.id, threadId: msg.threadId || null,
      user: { id: user.id, displayName: user.display_name },
    });
  });

  hub.on('ping', (ws) => ws.send(JSON.stringify({ type: 'pong' })));

  // Presence changes are pushed to contacts who are allowed to see online status.
  hub.on('internal:presence', ({ userId, online }) => {
    const user = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) return;
    if (!online) db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), userId);
    const level = privacyOf(user).onlineStatus;
    if (level === 'nobody') return;
    const watchers = level === 'contacts'
      ? db.all('SELECT contact_id AS id FROM contacts WHERE user_id = ?', userId)
      : db.all(
          `SELECT DISTINCT m2.user_id AS id FROM conversation_members m1
           JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
           JOIN conversations c ON c.id = m1.conversation_id AND c.type = 'dm'
           WHERE m1.user_id = ? AND m2.user_id != ?`, userId, userId,
        );
    hub.toUsers(watchers.map((w) => w.id).filter((id) => hub.isOnline(id)), { type: 'presence', userId, online });
  });
}
