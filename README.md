# wa-corporate-dashboard

Corporate WhatsApp dashboard — operate multiple WhatsApp accounts (sessions) from one
web UI: send ad-hoc & scheduled messages, manage contacts/templates, read inbox history.
Built on [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp library) + Express + SQLite.

> ⚠️ **Warning:** Baileys is an unofficial library. Automating a personal WhatsApp account
> can violate WhatsApp's Terms of Service and lead to a number ban. Use a dedicated number,
> keep volume reasonable, and avoid spam-like patterns.

## Features

- **Multi-session** — link several WhatsApp accounts; QR login; auto-reconnect; per-session auth stored on disk
- **Send** — ad-hoc text messages from any connected session (contact picker + template autofill), or sequentially to a contact group
- **Scheduled** — one-shot messages (local timezone input, UTC storage) or recurring (cron expression), 20s dispatch tick
- **Templates & Contacts** — reusable message templates, contact book with upsert by phone, many-to-many contact groups, and CSV import/export
- **Inbox** — inbound/outbound history stored in SQLite; per-chat thread view; keyword/date search and CSV exports for messages and contacts
- **Dashboard** — counters + recent outbound at a glance

## Requirements

- Node.js 24
- PHP-free, build-free — plain Express + EJS + Node.js built-in SQLite

## Setup

```bash
npm install
npm start          # or: npm run dev (node --watch)
```

Open `http://localhost:8300` (override with `PORT` env).

### Logging

Logging follows `NODE_ENV`:

- Development and test: Pino logs go to the terminal.
- Production: Pino logs go only to `LOG_FILE`, defaulting to `logs/app.log`.
- `LOG_LEVEL` defaults to `debug` outside production and `info` in production.

### Contact groups and CSV

Create named contact groups from **Contacts**, assign each contact to one or more groups, then choose a group from **Send** to deliver a message sequentially to every member. A failed recipient is reported without stopping the remaining sends.

Contact imports use a header row with `name,phone`, for example:

```csv
name,phone
Alex Smith,6281234567890
Jordan Lee,+6281234567891
```

Choose a target group during import if needed. Existing phone numbers are updated instead of duplicated. Contact exports include `name,phone,note,groups` and can be used as a backup.

You can override the production destination explicitly:

```bash
NODE_ENV=production LOG_FILE=/var/log/wa-corporate/app.log npm start
```

### Production with PM2

Install PM2 once, then run the included process configuration:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

PM2 restarts the app after crashes. In production, application logs are written to `logs/app.log` and do not stream to the terminal. Set `LOG_FILE` to override the path and `LOG_LEVEL` to control verbosity. PM2 fallback output is kept in `logs/pm2-out.log` and `logs/pm2-error.log`. Keep `logs/` on a filesystem with enough capacity and rotate or purge old files according to your host policy.

## Link your first WhatsApp session

1. Go to **Sessions** → enter a session name (e.g. `sales-1`) → Create/connect
2. A QR code appears (auto-refreshing). On the phone: WhatsApp → Linked devices → Link a device → scan
3. Status flips to `connected` and the phone number is shown

Session credentials are stored under `data/baileys/<name>/` and auto-restored on boot.

## Scheduling

- **One-shot:** pick date & time in the configured server timezone (`TZ`, default system timezone); values are stored as UTC
- **Recurring:** cron expression (5 fields, e.g. `0 9 * * 1-5` = weekdays at 09:00 in the server timezone)
- Dispatcher runs every 20 seconds; cancel any pending item from the Scheduled page

## Project structure

```
src/
  server.js      Express routes (7 pages + /api/qr)
  baileys.js     Multi-session manager (QR login, reconnect with backoff, inbox capture)
  scheduler.js   20s dispatch tick + cron "next run" calculator
  db.js          SQLite schema + helpers (Node.js built-in SQLite, data/wa.db, WAL mode)
  views/         EJS pages + partials
data/            Runtime data — gitignored (WhatsApp creds + wa.db)
```

## Security notes

- The dashboard supports optional HTTP Basic Auth. Set **both** variables to enable it:

  ```bash
  ADMIN_USER=admin ADMIN_PASS='use-a-long-random-password' npm start
  ```

  Requests without valid credentials receive `401 Authentication required`. If only one
  variable is set, the app refuses to boot so the dashboard is not accidentally exposed.
- If authentication is not configured, do not expose the dashboard to the public internet;
  keep it on localhost/VPN or behind a reverse proxy.
- `data/` contains WhatsApp credentials — never commit it (already gitignored).

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/SPRINT.md`](docs/SPRINT.md) — sprint board / progress
