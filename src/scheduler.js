/**
 * Scheduler for one-shot and recurring (cron) messages.
 * A 20s tick scans `scheduled` for due rows and dispatches them.
 */
const cron = require("node-cron");
const logger = require("./logger");
const store = require("./db");
const baileys = require("./baileys");

const MINUTE = 60 * 1000;

function nextFromCron(expr, from = new Date()) {
  // node-cron has no public "next run" API; step minute-by-minute up to 366 days
  if (!cron.validate(expr)) return null;
  const d = new Date(from.getTime() + MINUTE);
  d.setSeconds(0, 0);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * MINUTE);
  // Manual match: parse fields and test.
  const parts = expr.trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = parts;
  const fieldMatch = (spec, val) => {
    if (spec === "*") return true;
    return spec.split(",").some((piece) => {
      const stepMatch = piece.match(/^\*\/(\d+)$/);
      if (stepMatch) return val % Number(stepMatch[1]) === 0;
      const range = piece.match(/^(\d+)-(\d+)$/);
      if (range) return val >= Number(range[1]) && val <= Number(range[2]);
      return Number(piece) === val;
    });
  };
  while (d <= limit) {
    if (
      fieldMatch(min, d.getMinutes()) &&
      fieldMatch(hour, d.getHours()) &&
      fieldMatch(dom, d.getDate()) &&
      fieldMatch(mon, d.getMonth() + 1) &&
      fieldMatch(dow, d.getDay())
    ) {
      return d;
    }
    d.setTime(d.getTime() + MINUTE);
  }
  return null;
}

async function dispatch(row) {
  try {
    await baileys.sendText(row.session, row.chat_id, row.body);
    if (row.recurring && row.cron) {
      const next = nextFromCron(row.cron);
      if (next) {
        store.rescheduleRecurring(row.id, next.toISOString());
        return;
      }
    }
    store.markSent(row.id);
  } catch (e) {
    store.markFailed(row.id, e.message);
  }
}

function startScheduler() {
  const tick = async () => {
    try {
      const due = store.dueScheduled(new Date().toISOString());
      for (const row of due) await dispatch(row);
    } catch (e) {
      logger.error({ err: e }, "Scheduler tick failed");
    }
  };
  setInterval(tick, 20 * 1000);
  void tick();
}

module.exports = { startScheduler, nextFromCron };
