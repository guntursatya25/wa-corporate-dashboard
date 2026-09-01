const path = require("path");
const express = require("express");
const baileys = require("./baileys");
const store = require("./db");
const { startScheduler, nextFromCron } = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 8300;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const toCsv = (rows) => rows.length ? `${Object.keys(rows[0]).map(csvCell).join(",")}\n${rows.map((row) => Object.keys(rows[0]).map((key) => csvCell(row[key])).join(",")).join("\n")}\n` : "";

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
    templates: store.listTemplates(),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/send", async (req, res) => {
  const { session, chat_id, body } = req.body;
  try {
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
  res.render("templates", {
    templates: store.listTemplates(),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/templates", (req, res) => {
  const { name, body } = req.body;
  if (!name?.trim() || !body?.trim()) return res.redirect("/templates?msg=Name+and+body+required&kind=err");
  store.upsertTemplate(name.trim(), body);
  res.redirect("/templates?msg=Template+saved");
});

app.post("/templates/delete", (req, res) => {
  store.deleteTemplate(req.body.id);
  res.redirect("/templates?msg=Template+deleted");
});

// ---------- contacts ----------
app.get("/contacts", (req, res) => {
  res.render("contacts", {
    contacts: store.listContacts(),
    flash: req.query.msg ? flash(req.query.msg, req.query.kind || "ok") : null,
  });
});

app.post("/contacts", (req, res) => {
  const { name, phone, note } = req.body;
  if (!name?.trim() || !phone?.trim()) return res.redirect("/contacts?msg=Name+and+phone+required&kind=err");
  store.upsertContact(name.trim(), phone.trim(), note || "");
  res.redirect("/contacts?msg=Contact+saved");
});

app.post("/contacts/delete", (req, res) => {
  store.deleteContact(req.body.id);
  res.redirect("/contacts?msg=Contact+deleted");
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
  app.listen(PORT, () => console.log(`wa-corporate-dashboard on http://localhost:${PORT}`));
}

module.exports = { app, main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
