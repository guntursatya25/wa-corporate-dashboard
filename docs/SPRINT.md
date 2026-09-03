# Sprint Tracking — wa-corporate-dashboard

Source of truth: [`docs/PRD.md`](./PRD.md)
Status legend: ✅ done · 🔵 in progress · ⬜ todo · ⏸ deferred · ❌ blocked

**Current sprint:** Sprint 4 — Quality (M4) — in progress
**Last updated:** 2026-09-01

---

## Milestone burn-down

| Milestone | Scope | Status | Progress |
|---|---|---|---|
| **M1 — Make it run** | 7 EJS views + layout, README, boot verification | ✅ done | 10/10 |
| **M2 — Hardening** | Basic auth, process manager, reconnect/backoff | ✅ done | 4/4 |
| **M3 — Features** | Media send, bulk + throttle, inbox search, CSV export | 🔵 in progress | 2/5 |
| **M4 — Quality** | Smoke tests, CI, typecheck/lint | 🔵 in progress | 2/3 |

---

## Sprint 1 — M1: Make it run

| # | Task | PRD ref | Status | Notes |
|---|---|---|---|---|
| 1.1 | `views/partials/head.ejs` + `foot.ejs` — shared shell (nav, flash, styles) | 5.1 | ✅ | split head/foot (plain EJS, no layout dep) |
| 1.2 | `views/overview.ejs` — counters + recent outbox | 5.2 | ✅ | uses `counts`, `recent` |
| 1.3 | `views/sessions.ejs` — session list, start/stop, QR image w/ poller | 5.3 | ✅ | polls `/api/qr/:name` every 2s |
| 1.4 | `views/send.ejs` — session/contact/template pickers, template autofill | 5.4 | ✅ | vanilla JS autofill |
| 1.5 | `views/scheduled.ejs` — one-shot + cron form, pending list, cancel | 5.5 | ✅ | recurring → next-run display |
| 1.6 | `views/templates.ejs` — CRUD list + form | 5.6 | ✅ | |
| 1.7 | `views/contacts.ejs` — CRUD list + form | 5.7 | ✅ | |
| 1.8 | `views/inbox.ejs` — in/out lists, per-chat thread view | 5.8 | ✅ | `?chat=<chat_id>` filter |
| 1.9 | `README.md` — setup, run, first session, security warning | 6 | ✅ | |
| 1.10 | **Verify:** boot app, all 7 routes render 200, no EJS errors | 7 | ✅ | smoke-tested via curl: all routes 200 + QR API JSON |

**Sprint goal:** app boots and every page renders end-to-end; push to `main`.
**Outcome:** ✅ Sprint complete — all routes verified rendering (200) with zero EJS errors; QR poller + template autofill wired.

---

## Backlog — M2: Hardening

| # | Task | PRD ref | Status | Notes |
|---|---|---|---|---|
| 2.1 | Basic auth (env `ADMIN_USER`/`ADMIN_PASS`) on all routes | 4.2 / 9 Q1 | ✅ | Optional; both variables required together; invalid credentials return 401 |
| 2.2 | Process manager (systemd unit or pm2) + docs | 4.2 | ✅ | PM2 ecosystem config and README instructions |
| 2.3 | Baileys reconnect backoff + jitter | 4.2 | ✅ | Capped exponential backoff with jitter |
| 2.4 | Log rotation / pino file transport | 4.2 | ✅ | PM2 timestamped stdout/stderr files documented |

## Backlog — M3: Features

| # | Task | PRD ref | Status | Notes |
|---|---|---|---|---|
| 3.1 | Send image/document (upload → Baileys media message) | 4.3 | ⬜ | v1 text-only |
| 3.2 | Bulk send to contact group + throttle (min interval) | 4.3 | ⬜ | ban-risk guard |
| 3.3 | Inbox search (body/contact LIKE) + date filter | 4.3 | ✅ | Keyword and inclusive date filters on inbox |
| 3.4 | CSV export (messages, contacts) | 4.3 | ✅ | CSV download routes from inbox |
| 3.5 | Timezone handling for `run_at` display + entry | 9 Q2 | ✅ | Local UI timezone via `TZ`; UTC persisted in DB |

## Backlog — M4: Quality

| # | Task | PRD ref | Status | Notes |
|---|---|---|---|---|
| 4.1 | Boot smoke test (import modules, fake session dir) | 4.4 | ✅ | Dependency-free module and helper smoke coverage |
| 4.2 | GitHub Actions CI (install + smoke on push) | 4.4 | ✅ | Node 24 workflow runs `npm run check` |
| 4.3 | Route handler tests w/ supertest (no live WA) | 4.4 | ⬜ | |

---

## Open decisions (from PRD §9)

| Question | Decision | When |
|---|---|---|
| Basic auth in M1 or M2? | **M2** | ✅ decided |
| Timezone for `run_at`? | UTC in DB, local-time UI — M3 | ✅ decided |
| Multi-user audit? | Deferred to v2 | ⏸ |

## Risks watchlist (from PRD §8)

| Risk | Mitigation | Status |
|---|---|---|
| WhatsApp ban (unofficial lib) | throttle in M3, warn in README, low volume | 👁 monitored |
| Baileys breaking changes | pin the Baileys release, check changelog before bump | 👁 monitored |
| Session creds loss | `data/` backed up manually; note in README | 👁 monitored |
| Single-process SPOF | systemd auto-restart (M2) | ⬜ |

---

## Changelog

- **2026-09-01** — M4 tasks 4.1–4.2 complete: dependency-free smoke test and GitHub Actions CI added. M4 progress 2/3.
- **2026-09-01** — M3 task 3.5 complete: scheduled times now use configured local timezone in the UI and UTC in storage. M3 progress 3/5.
- **2026-09-01** — M2 complete: PM2 config/docs, reconnect backoff+jitter, and operational log handling documented. M2 progress 4/4.
- **2026-09-01** — M3 tasks 3.3–3.4 complete: inbox search/date filters and messages/contacts CSV exports added. M3 progress 2/5.
- **2026-09-01** — M2 task 2.1 complete: optional HTTP Basic Auth added; README updated. M2 progress 1/4.
- **2026-09-01** — Sprint 1 complete: 7 EJS views + partials + README shipped; all routes verified. M1 done, M2 next.
- **2026-09-01** — Sprint board created from PRD v1.0. Sprint 1 opened (M1, tasks 1.1–1.10).
- **2026-09-01** — PRD committed (`bb26918`); repo live at `guntursatya25/wa-corporate-dashboard`.
