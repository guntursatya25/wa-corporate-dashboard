const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "wa.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  chat_id TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  body TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  error TEXT DEFAULT '',
  wa_message_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_dir ON messages(direction, created_at);

CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL,
  run_at TEXT NOT NULL,
  cron TEXT DEFAULT '',
  recurring INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  last_run_at TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled(status, run_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---- helpers ----
const nowIso = () => new Date().toISOString();

module.exports = {
  db,
  nowIso,

  // contacts
  listContacts: () => db.prepare("SELECT * FROM contacts ORDER BY name").all(),
  upsertContact: (name, phone, note = "") =>
    db.prepare(
      `INSERT INTO contacts (name, phone, note) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET name=excluded.name, note=excluded.note`
    ).run(name, phone, note),
  deleteContact: (id) => db.prepare("DELETE FROM contacts WHERE id = ?").run(id),

  // templates
  listTemplates: () => db.prepare("SELECT * FROM templates ORDER BY name").all(),
  getTemplate: (id) => db.prepare("SELECT * FROM templates WHERE id = ?").get(id),
  upsertTemplate: (name, body) =>
    db.prepare(
      `INSERT INTO templates (name, body) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET body=excluded.body`
    ).run(name, body),
  deleteTemplate: (id) => db.prepare("DELETE FROM templates WHERE id = ?").run(id),

  // messages
  logMessage: (m) =>
    db.prepare(
      `INSERT INTO messages (session, direction, chat_id, contact_name, body, status, error, wa_message_id, created_at)
       VALUES (@session, @direction, @chat_id, @contact_name, @body, @status, @error, @wa_message_id, @created_at)`
    ).run({ contact_name: "", error: "", wa_message_id: "", status: "sent", created_at: nowIso(), ...m }),
  listMessages: (direction, limit = 200) =>
    db.prepare(
      `SELECT * FROM messages WHERE direction = ? ORDER BY created_at DESC LIMIT ?`
    ).all(direction, limit),
  listChat: (chatId, limit = 100) =>
    db.prepare(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?`
    ).all(chatId, limit),

  // scheduled
  createScheduled: (s) =>
    db.prepare(
      `INSERT INTO scheduled (session, chat_id, body, run_at, cron, recurring)
       VALUES (@session, @chat_id, @body, @run_at, @cron, @recurring)`
    ).run({ cron: "", recurring: 0, ...s }),
  listScheduled: (status = null, limit = 200) =>
    status
      ? db.prepare("SELECT * FROM scheduled WHERE status = ? ORDER BY run_at LIMIT ?").all(status, limit)
      : db.prepare("SELECT * FROM scheduled ORDER BY run_at DESC LIMIT ?").all(limit),
  dueScheduled: (nowIsoStr) =>
    db.prepare(
      `SELECT * FROM scheduled WHERE status = 'pending' AND recurring = 0 AND run_at <= ?
       UNION ALL
       SELECT * FROM scheduled WHERE status = 'pending' AND recurring = 1 AND run_at <= ?`
    ).all(nowIsoStr, nowIsoStr),
  markSent: (id) =>
    db.prepare("UPDATE scheduled SET status='sent', last_run_at=? WHERE id=?").run(nowIso(), id),
  markFailed: (id, err) =>
    db.prepare("UPDATE scheduled SET status='failed', last_run_at=?, last_error=? WHERE id=?").run(nowIso(), err, id),
  rescheduleRecurring: (id, nextRunAt) =>
    db.prepare("UPDATE scheduled SET run_at=?, last_run_at=? WHERE id=?").run(nextRunAt, nowIso(), id),
  cancelScheduled: (id) =>
    db.prepare("UPDATE scheduled SET status='cancelled' WHERE id=? AND status='pending'").run(id),
};
