const path = require("path");
const express = require("express");
const logger = require("./logger");
const baileys = require("./baileys");
const store = require("./db");
const { startScheduler, nextFromCron } = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 8300;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const toCsv = (rows) => rows.length ? `${Object.keys(rows[0]).map(csvCell).join(",")}\n${rows.map((row) => Object.keys(rows[0]).map((key) => csvCell(row[key])).join(",")).join("\n")}\n` : "";
const normalizePhone = (value) => String(value || "").trim().replace(/^\+/, "").replace(/[^0-9]/g, "");
const parseCsv = (input) => {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell.trim()); cell = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error("CSV contains an unclosed quote");
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
};
const groupIdsFromBody = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
const maxBroadcastRecipients = Number(process.env.MAX_BROADCAST_RECIPIENTS || 500);

// Optional HTTP Basic Auth. Configure both variables to protect the dashboard.
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
if ((ADMIN_USER && !ADMIN_PASS) || (!ADMIN_USER && ADMIN_PASS)) {
  throw new Error("ADMIN_USER and ADMIN_PASS must be configured together");
}
if (ADMIN_USER && ADMIN_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
    let credentials = "";
    try { credentials = Buffer.from(encoded, "base64").toString("utf8"); } catch {}
    const separator = credentials.indexOf(":");
    const user = separator >= 0 ? credentials.slice(0, separator) : "";
    const pass = separator >= 0 ? credentials.slice(separator + 1) : "";
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
    res.set("WWW-Authenticate", 'Basic realm="WA Corporate Dashboard"');
    res.status(401).send("Authentication required");
  });
}

// ---------- helpers ----------
const flash = (msg, kind = "ok") => ({ msg, kind });
const configuredTimezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const localDateTimeToUtc = (value) => {
  if (!value) return null;
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
};
const formatLocalDateTime = (iso) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: configuredTimezone, dateStyle: "short", timeStyle: "short",
}).format(new Date(iso));

// ---------- overview ----------
app.get("/", (req, res) => {
  res.render("overview", {
    sessions: baileys.listSessions(),
    counts: {
      contacts: store.listContacts().length,
      templates: store.listTemplates().length,
      pending: store.listScheduled("pending").length,
      out: store.listMessages("out", 1).length,
    },
    recent: store.listMessages("out", 8),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

// ---------- sessions ----------
app.get("/sessions", (req, res) => {
  res.render("sessions", {
    sessions: baileys.listSessions(),
    states: Object.fromEntries(
      baileys.listSessions().map((s) => [s.name, baileys.sessionState(s.name)])
    ),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/sessions/start", async (req, res) => {
  const name = (req.body.name || "").trim().replace(/[^\w-]/g, "");
  if (!name) return res.redirect("/sessions?msg=Session+name+required&kind=err");
  await baileys.startSession(name);
  res.redirect("/sessions");
});

app.post("/sessions/stop", async (req, res) => {
  await baileys.stopSession(req.body.name);
  res.redirect("/sessions?msg=Session+removed");
});

app.get("/api/qr/:name", (req, res) => {
  const s = baileys.sessionState(req.params.name);
  res.json({ status: s.status, qr: s.qr, phone: s.phone });
});

// ---------- send ----------
app.get("/send", (req, res) => {
  res.render("send", {
    sessions: baileys.listSessions().filter((s) => s.status === "connected"),
    contacts: store.listContacts(),
    groups: store.listGroups(),
    templates: store.listTemplates(),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/send", async (req, res) => {
  const { session, chat_id, body, group_id: groupId, send_mode: sendMode = "individual" } = req.body;
  if (!session || !body?.trim()) return res.redirect("/send?msg=Session+and+message+required&kind=err");
  if (sendMode !== "individual" && sendMode !== "group") return res.redirect("/send?msg=Invalid+recipient+mode&kind=err");
  try {
    if (sendMode === "group") {
      if (!groupId) return res.redirect("/send?msg=Group+required&kind=err");
      const group = store.getGroup(Number(groupId));
      if (!group) return res.redirect("/send?msg=Group+not+found&kind=err");
      const recipients = store.listContactsByGroup(Number(groupId));
      if (!recipients.length) return res.redirect("/send?msg=Selected+group+has+no+contacts&kind=err");
      if (recipients.length > maxBroadcastRecipients) {
        return res.redirect(`/send?msg=${encodeURIComponent(`Group exceeds the ${maxBroadcastRecipients}-contact broadcast limit`)}&kind=err`);
      }
      const sent = [];
      const failed = [];
      for (const contact of recipients) {
        try {
          await baileys.sendText(session, contact.phone, body);
          sent.push(contact.phone);
        } catch (error) {
          failed.push({ phone: contact.phone, error: error.message });
        }
      }
      const summary = `Group ${group.name}: ${sent.length} sent, ${failed.length} failed`;
      const detail = failed.length ? ` (${failed.map((item) => item.phone).join(", ")})` : "";
      return res.redirect(`/send?msg=${encodeURIComponent(summary + detail)}&kind=${failed.length ? "err" : "ok"}`);
    }
    if (!chat_id?.trim()) return res.redirect("/send?msg=Recipient+required&kind=err");
    await baileys.sendText(session, chat_id.trim(), body);
    res.redirect("/send?msg=Message+sent");
  } catch (e) {
    res.redirect(`/send?msg=${encodeURIComponent(e.message)}&kind=err`);
  }
});

// ---------- scheduled ----------
app.get("/scheduled", (req, res) => {
  res.render("scheduled", {
    sessions: baileys.listSessions().filter((s) => s.status === "connected"),
    contacts: store.listContacts(),
    templates: store.listTemplates(),
    pending: store.listScheduled("pending"),
    history: store.listScheduled(null, 40),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
    timezone: configuredTimezone,
    formatLocalDateTime,
  });
});

app.post("/scheduled", (req, res) => {
  const { session, chat_id, body, run_at, cron: cronExpr } = req.body;
  const recurring = Boolean(cronExpr && cronExpr.trim());
  if (!session || !chat_id || !body || (!run_at && !recurring)) {
    return res.redirect("/scheduled?msg=Missing+fields&kind=err");
  }
  let runAt;
  if (recurring) {
    const next = nextFromCron(cronExpr.trim());
    if (!next) return res.redirect("/scheduled?msg=Invalid+cron+expression&kind=err");
    runAt = next.toISOString();
  } else {
    runAt = localDateTimeToUtc(run_at);
    if (!runAt) return res.redirect("/scheduled?msg=Invalid+date&kind=err");
  }
  store.createScheduled({
    session,
    chat_id: chat_id.trim(),
    body,
    run_at: runAt,
    cron: recurring ? cronExpr.trim() : "",
    recurring: recurring ? 1 : 0,
  });
  res.redirect("/scheduled?msg=Scheduled");
});

app.post("/scheduled/cancel", (req, res) => {
  store.db.prepare("UPDATE scheduled SET status='cancelled' WHERE id=? AND status='pending'").run(req.body.id);
  res.redirect("/scheduled?msg=Cancelled");
});

// ---------- templates ----------
app.get("/templates", (req, res) => {
  const editId = req.query.edit ? Number(req.query.edit) : null;
  const editTemplate = editId ? store.getTemplate(editId) : null;
  res.render("templates", {
    templates: store.listTemplates(),
    editTemplate,
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/templates", (req, res) => {
  const { id, name, body } = req.body;
  if (!name?.trim() || !body?.trim()) return res.redirect("/templates?msg=Name+and+body+required&kind=err");
  if (id) {
    const existing = store.getTemplate(Number(id));
    if (!existing) return res.redirect("/templates?msg=Template+not+found&kind=err");
    store.updateTemplate(Number(id), name.trim(), body);
  } else {
    store.upsertTemplate(name.trim(), body);
  }
  res.redirect("/templates?msg=Template+saved");
});

app.post("/templates/delete", (req, res) => {
  store.deleteTemplate(req.body.id);
  res.redirect("/templates?msg=Template+deleted");
});

// ---------- contacts ----------
app.get("/contacts", (req, res) => {
  const editId = req.query.edit ? Number(req.query.edit) : null;
  const editContact = editId ? store.getContact(editId) : null;
  res.render("contacts", {
    contacts: store.listContacts(),
    groups: store.listGroups(),
    editContact,
    editGroupIds: editContact ? store.listContactGroups(editContact.id).map((group) => group.id) : [],
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/contacts", (req, res) => {
  const { id, name, phone, note } = req.body;
  const normalizedPhone = normalizePhone(phone);
  if (!name?.trim() || !normalizedPhone) return res.redirect("/contacts?msg=Name+and+valid+phone+required&kind=err");
  try {
    if (id) {
      const existing = store.getContact(Number(id));
      if (!existing) return res.redirect("/contacts?msg=Contact+not+found&kind=err");
      store.updateContact(Number(id), name.trim(), normalizedPhone, note || "");
      store.setContactGroups(Number(id), groupIdsFromBody(req.body.groups));
    } else {
      store.upsertContact(name.trim(), normalizedPhone, note || "");
      const contact = store.getContactByPhone(normalizedPhone);
      store.setContactGroups(contact.id, groupIdsFromBody(req.body.groups));
    }
    res.redirect("/contacts?msg=Contact+saved");
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.redirect("/contacts?msg=Phone+number+already+exists&kind=err");
    throw error;
  }
});

app.post("/contacts/delete", (req, res) => {
  store.deleteContact(req.body.id);
  res.redirect("/contacts?msg=Contact+deleted");
});

app.post("/groups", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.redirect("/contacts?msg=Group+name+required&kind=err");
  try {
    store.createGroup(name);
    res.redirect("/contacts?msg=Group+created");
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.redirect("/contacts?msg=Group+already+exists&kind=err");
    throw error;
  }
});

app.post("/groups/delete", (req, res) => {
  store.deleteGroup(req.body.id);
  res.redirect("/contacts?msg=Group+deleted");
});

app.post("/contacts/import", (req, res) => {
  const csv = String(req.body.csv || "");
  if (!csv.trim()) return res.redirect("/contacts?msg=CSV+content+required&kind=err");
  try {
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.redirect("/contacts?msg=CSV+must+include+a+header+and+at+least+one+contact&kind=err");
    const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").toLowerCase());
    const nameIndex = headers.indexOf("name");
    const phoneIndex = headers.indexOf("phone");
    if (nameIndex < 0 || phoneIndex < 0) return res.redirect("/contacts?msg=CSV+needs+name+and+phone+columns&kind=err");
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const name = String(row[nameIndex] || "").trim();
      const phone = normalizePhone(row[phoneIndex]);
      if (!name || !phone) { skipped += 1; continue; }
      const existing = store.getContactByPhone(phone);
      store.upsertContact(name, phone, existing?.note || "");
      imported += 1;
      if (req.body.group_id) {
        const contact = store.getContactByPhone(phone);
        store.addContactToGroup(contact.id, Number(req.body.group_id));
      }
    }
    const suffix = skipped ? `, ${skipped} skipped` : "";
    res.redirect(`/contacts?msg=${encodeURIComponent(`${imported} contacts imported${suffix}`)}`);
  } catch (error) {
    res.redirect(`/contacts?msg=${encodeURIComponent(error.message)}&kind=err`);
  }
});

// ---------- inbox ----------
app.get("/inbox", (req, res) => {
  const chatId = req.query.chat || null;
  const filters = { query: req.query.q || "", from: req.query.from || "", to: req.query.to || "" };
  const filtered = filters.query || filters.from || filters.to;
  const messages = filtered ? store.searchMessages(filters) : null;
  res.render("inbox", {
    inbox: messages ? messages.filter((m) => m.direction === "in") : store.listMessages("in", 200),
    outbox: messages ? messages.filter((m) => m.direction === "out") : store.listMessages("out", 200),
    chat: chatId ? store.listChat(chatId, 100) : null,
    chat_id: chatId,
    filters,
    flash: null,
  });
});

app.get("/export/:type.csv", (req, res) => {
  const rows = req.params.type === "contacts" ? store.exportContacts() : req.params.type === "messages" ? store.exportMessages() : null;
  if (!rows) return res.status(404).send("Not found");
  res.type("text/csv").set("Content-Disposition", `attachment; filename=${req.params.type}.csv`).send(toCsv(rows));
});

// ---------- boot ----------
async function main() {
  await baileys.restoreSessions();
  startScheduler();
  app.listen(PORT, () => logger.info({ port: PORT }, "wa-corporate-dashboard started"));
}

module.exports = { app, main };

if (require.main === module) {
  main().catch((e) => {
    logger.fatal({ err: e }, "Application failed to start");
    process.exit(1);
  });
}
