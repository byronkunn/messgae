import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  status_emoji TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  avatar_file_id TEXT,
  banner_file_id TEXT,
  privacy TEXT NOT NULL DEFAULT '{}',
  site_role TEXT NOT NULL DEFAULT 'user' CHECK (site_role IN ('user','site_moderator','site_admin','super_admin')),
  evidence_access INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','restricted','suspended','banned')),
  state_until INTEGER,
  state_reason TEXT,
  recovery_verifier TEXT NOT NULL,
  recovery_rotated_at INTEGER NOT NULL,
  totp_secret_sealed TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_counter INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_created ON users(created_at, id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  revoked_at INTEGER,
  elevated_until INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS device_links (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  poll_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_session_id TEXT,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS user_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, muted_id)
);

-- Spaces ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_file_id TEXT,
  banner_file_id TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  discoverable INTEGER NOT NULL DEFAULT 0,
  join_mode TEXT NOT NULL DEFAULT 'invite' CHECK (join_mode IN ('open','approval','invite')),
  topic TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  plan TEXT NOT NULL DEFAULT 'free',
  explore_removed INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  timeout_until INTEGER,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS space_members_user ON space_members(user_id);
CREATE TABLE IF NOT EXISTS join_requests (
  target_type TEXT NOT NULL CHECK (target_type IN ('group','space')),
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_bans (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  banned_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_roles (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  permissions INTEGER NOT NULL,
  system_key TEXT, -- 'everyone' | 'moderator' | 'admin' | NULL for custom roles
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS space_roles_space ON space_roles(space_id, position);
CREATE TABLE IF NOT EXISTS space_member_roles (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES space_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS space_categories (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS space_audit (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- Conversations: DMs, groups and Space channels share one model -------------
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dm','group','channel')),
  dm_key TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  avatar_file_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  -- groups
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  discoverable INTEGER NOT NULL DEFAULT 0,
  join_mode TEXT NOT NULL DEFAULT 'invite' CHECK (join_mode IN ('open','approval','invite')),
  topic TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  explore_removed INTEGER NOT NULL DEFAULT 0,
  -- channels
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES space_categories(id) ON DELETE SET NULL,
  channel_type TEXT CHECK (channel_type IN ('text','announcement','media','forum')),
  is_private INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS conversations_space ON conversations(space_id, position);
CREATE INDEX IF NOT EXISTS conversations_type ON conversations(type, created_at, id);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator','admin','owner')),
  joined_at INTEGER NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  cleared_at INTEGER,
  last_read_at INTEGER,
  timeout_until INTEGER,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS conversation_bans (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  banned_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_channel ON threads(channel_id, last_message_at);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('group','space')),
  target_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','media','file','voice','sticker','poll','system')),
  body TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  data TEXT, -- JSON: poll definition, sticker id, system event, link list
  has_links INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  pinned_at INTEGER,
  pinned_by TEXT
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at, id);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX IF NOT EXISTS attachments_file ON message_attachments(file_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- Files -----------------------------------------------------------------------
-- A blob is a unique stored object (content-addressed by SHA-256, encrypted at rest).
-- A file is a user's reference to a blob; sharing never copies the blob.
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  iv TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS blobs_sha ON blobs(sha256, deleted_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  category TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  trashed_at INTEGER,
  purged_at INTEGER,
  origin_message_id TEXT,
  origin_conversation_id TEXT,
  password_verifier TEXT,
  password_sealed TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'ok' CHECK (moderation_status IN ('ok','restricted','quarantined','removed')),
  download_count INTEGER NOT NULL DEFAULT 0,
  share_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  bandwidth_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id, created_at, id);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);
CREATE TABLE IF NOT EXISTS file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('upload','download','view','share','link_download')),
  user_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS file_events_file ON file_events(file_id, type, created_at);
CREATE INDEX IF NOT EXISTS file_events_time ON file_events(created_at, type);

CREATE TABLE IF NOT EXISTS file_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES files(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  audience TEXT NOT NULL CHECK (audience IN ('anyone','selected','contacts')),
  selected_users TEXT NOT NULL DEFAULT '[]',
  password_verifier TEXT,
  password_sealed TEXT,
  expires_at INTEGER,
  max_downloads INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  allow_download INTEGER NOT NULL DEFAULT 1,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS file_links_creator ON file_links(created_by, created_at);

CREATE TABLE IF NOT EXISTS download_tickets (
  token_hash TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  user_id TEXT,
  link_id TEXT,
  expires_at INTEGER NOT NULL
);

-- Notifications, reports, moderation -------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('user','message','conversation','space','file','link')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '{}',
  space_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','escalated','resolved','dismissed')),
  assigned_to TEXT,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at, id);
CREATE INDEX IF NOT EXISTS reports_space ON reports(space_id, status);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'site', -- 'site' | 'space:<id>' | 'group:<id>'
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  report_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_target ON moderation_actions(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS moderation_created ON moderation_actions(created_at, id);

-- Append-only, hash-chained audit trail for sensitive actions.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  reason TEXT,
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id, seq);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action, seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  user_id TEXT,
  ip TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_time ON security_events(created_at, type);
`;

export function openDb(file) {
  const dbFile = file ?? path.join(config.dataDir, 'messgae.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  if (dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return wrap(db);
}

/** Thin convenience layer over node:sqlite with a statement cache and transactions. */
function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  const db = {
    raw,
    get: (sql, ...params) => clean(stmt(sql).get(...params)),
    all: (sql, ...params) => stmt(sql).all(...params).map(clean),
    run: (sql, ...params) => stmt(sql).run(...params),
    exec: (sql) => raw.exec(sql),
    value: (sql, ...params) => {
      const row = stmt(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  return db;
}

function clean(row) {
  if (!row) return row;
  return { ...row };
}
