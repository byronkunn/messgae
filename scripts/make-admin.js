// Usage: npm run make-admin -- <username> [role] [--evidence]
// role: site_moderator | site_admin | super_admin (default super_admin)
import { openDb } from '../server/db.js';
import { audit } from '../server/lib/audit.js';
import { SITE_ROLES } from '../server/lib/perms.js';

const [username, role = 'super_admin', ...flags] = process.argv.slice(2);
if (!username || !SITE_ROLES.includes(role)) {
  console.error('Usage: npm run make-admin -- <username> [site_moderator|site_admin|super_admin] [--evidence]');
  process.exit(1);
}
const db = openDb();
const user = db.get('SELECT * FROM users WHERE username = ?', username);
if (!user) {
  console.error(`No user named "${username}".`);
  process.exit(1);
}
const evidence = flags.includes('--evidence') && role !== 'site_moderator' ? 1 : 0;
db.run('UPDATE users SET site_role = ?, evidence_access = ? WHERE id = ?', role, evidence, user.id);
audit(db, { actor: null, action: 'staff.permissions_changed', targetType: 'user', targetId: user.id, reason: 'Set from command line (make-admin)', detail: { role, evidenceAccess: !!evidence } });
console.log(`@${username} is now ${role}${evidence ? ' with Evidence Access' : ''}. They must enable 2FA (Settings → Security) before using Admin.`);
db.close();
