const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(process.env.WA_DB_PATH || path.join(dataDir, "wa.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

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

CREATE TABLE IF NOT EXISTS contact_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_group_members (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_group_members_group ON contact_group_members(group_id, contact_id);

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
  listContacts: () => db.prepare(
    `SELECT c.*, COALESCE(group_data.group_names, '') AS group_names
     FROM contacts c
     LEFT JOIN (
       SELECT cgm.contact_id, GROUP_CONCAT(cg.name, ', ') AS group_names
       FROM contact_group_members cgm
       JOIN contact_groups cg ON cg.id = cgm.group_id
       GROUP BY cgm.contact_id
     ) group_data ON group_data.contact_id = c.id
     ORDER BY c.name`
  ).all(),
  getContact: (id) => db.prepare("SELECT * FROM contacts WHERE id = ?").get(id),
  getContactByPhone: (phone) => db.prepare("SELECT * FROM contacts WHERE phone = ?").get(phone),
  upsertContact: (name, phone, note = "") =>
    db.prepare(
      `INSERT INTO contacts (name, phone, note) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET name=excluded.name, note=excluded.note`
    ).run(name, phone, note),
  updateContact: (id, name, phone, note = "") =>
    db.prepare("UPDATE contacts SET name=?, phone=?, note=? WHERE id=?").run(name, phone, note, id),
  deleteContact: (id) => db.prepare("DELETE FROM contacts WHERE id = ?").run(id),

  // contact groups
  listGroups: () => db.prepare(
    `SELECT cg.*, COUNT(cgm.contact_id) AS member_count
     FROM contact_groups cg
     LEFT JOIN contact_group_members cgm ON cgm.group_id = cg.id
     GROUP BY cg.id ORDER BY cg.name`
  ).all(),
  getGroup: (id) => db.prepare("SELECT * FROM contact_groups WHERE id = ?").get(id),
  createGroup: (name) => db.prepare("INSERT INTO contact_groups (name) VALUES (?)").run(name),
  deleteGroup: (id) => db.prepare("DELETE FROM contact_groups WHERE id = ?").run(id),
  setContactGroups: (contactId, groupIds = []) => {
    db.prepare("DELETE FROM contact_group_members WHERE contact_id = ?").run(contactId);
    const add = db.prepare("INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)");
    for (const groupId of groupIds) {
      if (db.prepare("SELECT 1 FROM contact_groups WHERE id = ?").get(groupId)) add.run(contactId, groupId);
    }
  },
  addContactToGroup: (contactId, groupId) => {
    if (db.prepare("SELECT 1 FROM contact_groups WHERE id = ?").get(groupId)) {
      db.prepare("INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)").run(contactId, groupId);
    }
  },
  listContactGroups: (contactId) => db.prepare(
    "SELECT cg.* FROM contact_groups cg JOIN contact_group_members cgm ON cgm.group_id = cg.id WHERE cgm.contact_id = ? ORDER BY cg.name"
  ).all(contactId),
  listContactsByGroup: (groupId) => db.prepare(
    `SELECT c.* FROM contacts c
     JOIN contact_group_members cgm ON cgm.contact_id = c.id
     WHERE cgm.group_id = ? ORDER BY c.name`
  ).all(groupId),

  // templates
  listTemplates: () => db.prepare("SELECT * FROM templates ORDER BY name").all(),
  getTemplate: (id) => db.prepare("SELECT * FROM templates WHERE id = ?").get(id),
  upsertTemplate: (name, body) =>
    db.prepare(
      `INSERT INTO templates (name, body) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET body=excluded.body`
    ).run(name, body),
  updateTemplate: (id, name, body) =>
    db.prepare("UPDATE templates SET name=?, body=? WHERE id=?").run(name, body, id),
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
  searchMessages: ({ query = "", from = "", to = "", limit = 200 } = {}) => {
    const clauses = [];
    const params = [];
    if (query.trim()) {
      clauses.push("(body LIKE ? OR chat_id LIKE ? OR contact_name LIKE ?)");
      const term = `%${query.trim()}%`;
      params.push(term, term, term);
    }
    if (from) { clauses.push("created_at >= ?"); params.push(`${from}T00:00:00.000Z`); }
    if (to) { clauses.push("created_at < ?"); params.push(`${to}T23:59:59.999Z`); }
    params.push(limit);
    return db.prepare(`SELECT * FROM messages ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params);
  },
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

  exportMessages: () => db.prepare("SELECT * FROM messages ORDER BY created_at ASC").all(),
  exportContacts: () => db.prepare(
    `SELECT c.name, c.phone, c.note, COALESCE(group_data.group_names, '') AS groups
     FROM contacts c
     LEFT JOIN (
       SELECT cgm.contact_id, GROUP_CONCAT(cg.name, ', ') AS group_names
       FROM contact_group_members cgm
       JOIN contact_groups cg ON cg.id = cgm.group_id
       GROUP BY cgm.contact_id
     ) group_data ON group_data.contact_id = c.id
     ORDER BY c.name`
  ).all(),
};
