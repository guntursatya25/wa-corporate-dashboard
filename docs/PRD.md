# PRD — wa-corporate-dashboard

**Version:** 1.0 · **Date:** 2026-09-01 · **Status:** Draft for execution
**Repo:** `git@github.com:guntursatya25/wa-corporate-dashboard.git` (branch `main`)

---

## 1. Overview

A self-hosted **Corporate WhatsApp Dashboard**: a web UI for operating multiple WhatsApp
accounts (sessions) over the Baileys library, sending ad-hoc and scheduled messages,
managing contacts/message templates, and reading the inbox history — all backed by a
local SQLite database. No external SaaS; everything runs on one Node.js process.

**Target user:** a small team (ops/admin) that runs outbound WhatsApp messaging for a
business (reminders, notifications, follow-ups) and needs a shared dashboard instead of
several personal phones.

**Non-goals (v1):**
- Multi-user auth / RBAC (single shared dashboard; basic auth optional in v1.5)
- Media sending (images/files) — text only in v1
- Official WhatsApp Business API — this is Baileys (unofficial); ToS risk documented
- Mobile app / responsive-first design — desktop web is fine

---

## 2. Current state (what exists today)

| Component | Status |
|---|---|
| `src/server.js` — Express app, routes for sessions/send/scheduled/templates/contacts/inbox | ✅ done |
| `src/baileys.js` — multi-session manager (QR login, reconnect, inbox capture, sendText) | ✅ done |
| `src/db.js` — SQLite schema: contacts, templates, messages, scheduled, settings | ✅ done |
| `src/scheduler.js` — 20s tick, one-shot + cron recurring dispatch | ✅ done |
| `src/views/*.ejs` — **missing** (server renders 7 views that don't exist) | ❌ gap |
| `README.md` | ❌ gap |
| Tests, process manager config, auth | ❌ gap |

**The immediate execution goal is to close the UI gap and make the app runnable end-to-end.**

---

## 3. Goals & success metrics

| Goal | Metric |
|---|---|
| App boots and every page renders | `npm start` → 0 errors, all 7 routes return 200 |
| Operator can link a WhatsApp account in < 2 min | QR scan → status "connected" |
| Operator can send a message in < 30 s | contact picker → send → appears in inbox |
| Scheduled messages fire on time | 20s tick; one-shot within 1 min of `run_at`, cron within 2 min of schedule |
| History is durable | messages survive restart (SQLite WAL) |

---

## 4. Functional requirements

### 4.1 Overview page (`GET /`)
- Cards: sessions connected count, contacts, templates, pending scheduled, today's outbound.
- Recent 8 outbound messages table.
- Flash message banner from `?msg=&kind=`.

### 4.2 Sessions (`GET /sessions`)
- Table of sessions: name, status (`connecting|qr|connected|reconnecting|offline|logged_out`), phone, hasAuth.
- Start form (name → POST `/sessions/start`), Stop button (POST `/sessions/stop`).
- **QR flow:** when a session status is `qr`, poll `GET /api/qr/:name` every 2s and render the
  data-URL QR image; auto-hide when status becomes `connected`.
- Acceptance: link a real device, QR visible → scan → status flips to connected, phone shown.

### 4.3 Send (`GET/POST /send`)
- Pick session (only `connected`), pick contact (dropdown from contacts OR free-text chat_id),
  template dropdown auto-fills body (client-side JS), message textarea.
- POST → `baileys.sendText` → redirect with success/error flash.
- Acceptance: send to a real number; message appears in inbox/outbox and on the phone.

### 4.4 Scheduled (`GET/POST /scheduled`, `POST /scheduled/cancel`)
- Create: session, chat_id, body (or template), either `run_at` (datetime-local) or cron expr.
- List: pending (with cancel button) + history (sent/failed/cancelled, last 40).
- Acceptance: schedule a one-shot 2 min ahead → fires; cron `*/2 * * * *` → fires every 2 min;
  cancel removes it from pending.

### 4.5 Templates (`GET/POST /templates`, delete)
- CRUD-ish: upsert by unique name, delete. Used by Send & Scheduled pages.

### 4.6 Contacts (`GET/POST /contacts`, delete)
- name + phone (unique, upsert) + note. Used by Send & Scheduled chat_id pickers.

### 4.7 Inbox (`GET /inbox`)
- Two columns: inbound (200) and outbound (200); clicking a chat filters `listChat(chatId)`.
- Acceptance: receive a WhatsApp message → appears in inbound within seconds (Baileys upsert).

### 4.8 API (already exists, keep stable)
- `GET /api/qr/:name` → `{status, qr, phone}` — used by the sessions page poller.

---

## 5. UX / UI requirements

- Server-rendered EJS, one shared `layout` partial (header nav + flash banner + minimal CSS).
- Nav: Overview · Sessions · Send · Scheduled · Templates · Contacts · Inbox.
- Single embedded stylesheet (`public/style.css` or inline in layout) — no build step, no framework.
- Status badges color-coded (green connected, amber qr/connecting, red failed/offline).
- No client framework; small vanilla JS snippets only (QR poller, template autofill).

---

## 6. Technical architecture

```
Browser ── EJS pages ── Express (server.js)
                          ├─ baileys.js  ── WhatsApp (multi-socket, one per session)
                          ├─ scheduler.js ── 20s tick → dueScheduled → sendText
                          └─ db.js ── Node.js built-in SQLite (data/wa.db, WAL)
Auth state on disk: data/baileys/<name>/creds.json (gitignored)
```

- Node 24, CommonJS, built-in node:sqlite, no TypeScript, no bundler.
- Ports: `PORT` env or 8300.

---

## 7. Non-functional requirements

- **Security:** dashboard currently unauthenticated — bind awareness: if exposed, add
  HTTP basic auth via env (`DASH_USER`/`DASH_PASS`) — *v1.5 item, noted in PRD*.
- **Data safety:** `data/` gitignored (WhatsApp creds + DB never in git).
- **Reliability:** Baileys auto-reconnect on non-loggedOut disconnects (3s backoff) — done.
- **Logging:** shared Pino logger; development/test logs go to the terminal, while production logs go only to `LOG_FILE` (default `logs/app.log`).

---

## 8. Milestones & execution plan

### M1 — Make it run (P0, this is the next execution step)
1. `src/views/layout.ejs` (nav + flash + CSS) + partials.
2. Seven views: `overview`, `sessions`, `send`, `scheduled`, `templates`, `contacts`, `inbox`.
3. `README.md` (setup, run, link session, security warning).
4. Verify: `npm install && npm start` → walk all 7 pages, link a session, send, schedule.
   - **Acceptance:** every route 200; QR connect works; send + schedule fire.

### M2 — Operational hardening (P1)
- systemd unit or `ecosystem.config.js` (pm2) + `NODE_ENV` handling.
- HTTP basic auth middleware (env-driven).
- Outgoing send failure retry (1 retry after 30s) for scheduled rows.
- Log rotation / request log.

### M3 — Feature growth (P2)
- Media send (image/file) via Baileys; media inbox preview.
- Bulk send to a contact group with per-recipient throttle (anti-ban).
- Chat labels/tags, simple search in inbox.
- Export CSV of messages/scheduled.

### M4 — Quality (P2)
- Smoke tests (boot app with mocked Baileys, hit routes).
- CI: GitHub Actions — `node --check` + boot test on push.

---

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Baileys is unofficial → number ban | high | throttle bulk sends (M3), warn in README, avoid spam patterns |
| `nextFromCron` minute-stepping is O(days) for rare crons | low | bounded at 366 days; acceptable |
| Session creds lost → re-link required | medium | docs; creds persisted on disk per session |
| Single process = single point of failure | medium | M2 process manager + auto-restart |

---

## 10. Open questions

1. Basic auth in M1 or M2? (default: M2)
2. Timezone for `run_at` — server-local (current) or a configurable TZ setting? (default: server-local, revisit in M3)
3. Does the team need multi-user audit (who sent what)? (deferred to v2)
