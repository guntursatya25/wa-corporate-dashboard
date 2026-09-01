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

// ---------- helpers ----------
const flash = (msg, kind = "ok") => ({ msg, kind });

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
    const d = new Date(run_at);
    if (Number.isNaN(d.getTime())) return res.redirect("/scheduled?msg=Invalid+date&kind=err");
    runAt = d.toISOString();
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
  res.render("inbox", {
    inbox: store.listMessages("in", 200),
    outbox: store.listMessages("out", 200),
    chat: chatId ? store.listChat(chatId, 100) : null,
    chat_id: chatId,
    flash: null,
  });
});

// ---------- boot ----------
async function main() {
  await baileys.restoreSessions();
  startScheduler();
  app.listen(PORT, () => console.log(`wa-corporate-dashboard on http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
