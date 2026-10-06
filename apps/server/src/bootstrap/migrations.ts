import { PLATFORM_MIGRATION } from '../platform/database/index.js';
import type { Migration } from '../platform/database/index.js';
import { JOB_MIGRATION } from '../platform/jobs/index.js';

export const CORE_MIGRATION: Migration = {
  version: 3,
  sql: `
CREATE TABLE mail_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL REFERENCES mail_servers(id),
 username TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(server_id, username), UNIQUE(server_id, id)
);
CREATE TABLE sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, user_id INTEGER NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'cookie',
 FOREIGN KEY(server_id,user_id) REFERENCES users(server_id,id)
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
CREATE TABLE conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL REFERENCES mail_servers(id),
 kind TEXT NOT NULL CHECK(kind IN ('direct','group')), title TEXT, direct_pair TEXT,
 created_at TEXT NOT NULL, last_message_at TEXT,
 UNIQUE(server_id,id), UNIQUE(server_id,direct_pair)
);
CREATE TABLE members (
 server_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 PRIMARY KEY(server_id,conversation_id,user_id),
 FOREIGN KEY(server_id,conversation_id) REFERENCES conversations(server_id,id),
 FOREIGN KEY(server_id,user_id) REFERENCES users(server_id,id)
);
CREATE INDEX members_user_idx ON members(server_id,user_id,conversation_id);
CREATE TABLE conversation_requests (
 server_id TEXT NOT NULL, sender_id INTEGER NOT NULL, client_request_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL, conversation_id INTEGER NOT NULL,
 PRIMARY KEY(server_id,sender_id,client_request_id),
 FOREIGN KEY(server_id,sender_id) REFERENCES users(server_id,id),
 FOREIGN KEY(server_id,conversation_id) REFERENCES conversations(server_id,id)
);
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, conversation_id INTEGER NOT NULL,
 sender_id INTEGER NOT NULL, client_message_id TEXT NOT NULL, text TEXT, created_at TEXT NOT NULL,
 content_expired INTEGER NOT NULL DEFAULT 0 CHECK(content_expired IN (0,1)),
 CHECK((content_expired=0 AND text IS NOT NULL) OR (content_expired=1 AND text IS NULL)),
 UNIQUE(server_id,id), UNIQUE(server_id,sender_id,client_message_id),
 FOREIGN KEY(server_id,conversation_id) REFERENCES conversations(server_id,id),
 FOREIGN KEY(server_id,sender_id) REFERENCES users(server_id,id)
);
CREATE INDEX messages_conversation_id_idx ON messages(server_id,conversation_id,id);
CREATE INDEX messages_created_idx ON messages(server_id,created_at);
CREATE TABLE message_dedup (
 server_id TEXT NOT NULL, sender_id INTEGER NOT NULL, client_message_id TEXT NOT NULL,
 conversation_id INTEGER NOT NULL, message_id INTEGER, created_at TEXT NOT NULL, expired_at TEXT,
 PRIMARY KEY(server_id,sender_id,client_message_id),
 FOREIGN KEY(server_id,sender_id) REFERENCES users(server_id,id),
 FOREIGN KEY(server_id,conversation_id) REFERENCES conversations(server_id,id),
 FOREIGN KEY(server_id,message_id) REFERENCES messages(server_id,id)
);
CREATE TABLE message_files (
 server_id TEXT NOT NULL, message_id INTEGER NOT NULL, file_id TEXT NOT NULL,
 PRIMARY KEY(server_id,message_id,file_id), UNIQUE(server_id,file_id),
 FOREIGN KEY(server_id,message_id) REFERENCES messages(server_id,id)
);
CREATE TABLE read_cursors (
 server_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 last_read_message_id INTEGER NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(server_id,conversation_id,user_id),
 FOREIGN KEY(server_id,conversation_id,user_id) REFERENCES members(server_id,conversation_id,user_id)
);
CREATE TABLE retention_policies (
 server_id TEXT PRIMARY KEY REFERENCES mail_servers(id), message_days INTEGER NOT NULL,
 file_days INTEGER NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL REFERENCES mail_servers(id),
 actor_id INTEGER, action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL,
 metadata_json TEXT NOT NULL, request_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
 FOREIGN KEY(server_id,actor_id) REFERENCES users(server_id,id)
);
CREATE INDEX audit_server_id_idx ON audit_events(server_id,id);
`,
};

export const FILES_MIGRATION: Migration = {
  version: 4,
  sql: `
CREATE TABLE files (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL, owner_user_id INTEGER NOT NULL,
 conversation_id INTEGER NOT NULL, filename TEXT, mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=5000000),
 object_key TEXT NOT NULL UNIQUE, sha256 TEXT,
 state TEXT NOT NULL CHECK(state IN ('uploading','ready','attached','deleting','deleted')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, message_id INTEGER,
 delete_reason TEXT, deleted_at TEXT,
 FOREIGN KEY(server_id,owner_user_id) REFERENCES users(server_id,id),
 FOREIGN KEY(server_id,conversation_id) REFERENCES conversations(server_id,id)
);
CREATE INDEX files_expiry_idx ON files(server_id,state,expires_at);
CREATE INDEX files_conversation_idx ON files(server_id,conversation_id,created_at);
CREATE INDEX files_owner_idx ON files(server_id,owner_user_id,state);
CREATE INDEX files_message_idx ON files(server_id,message_id);
CREATE TABLE retention_progress (
 server_id TEXT NOT NULL REFERENCES mail_servers(id), kind TEXT NOT NULL,
 last_id TEXT, cutoff_at TEXT, policy_version INTEGER NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(server_id,kind)
);
`,
};

export const MIGRATIONS: readonly Migration[] = [
  PLATFORM_MIGRATION,
  JOB_MIGRATION,
  CORE_MIGRATION,
  FILES_MIGRATION,
];
