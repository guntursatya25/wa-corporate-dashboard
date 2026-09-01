const assert = require("assert");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.TZ = "UTC";
process.env.WA_DB_PATH = path.join(os.tmpdir(), `wa-dashboard-smoke-${process.pid}.db`);

const store = require("../src/db");
const { nextFromCron } = require("../src/scheduler");
const baileys = require("../src/baileys");
const { app } = require("../src/server");

assert.ok(app);
assert.ok(Array.isArray(baileys.listSessions()));
assert.ok(nextFromCron("*/5 * * * *", new Date("2026-01-01T00:00:00.000Z")));
assert.strictEqual(nextFromCron("not-a-cron", new Date("2026-01-01T00:00:00.000Z")), null);

const contact = store.upsertContact("Smoke Test", "999999999999", "test");
assert.ok(contact);
assert.ok(store.listContacts().some((row) => row.phone === "999999999999"));
store.deleteContact(store.listContacts().find((row) => row.phone === "999999999999").id);

console.log("smoke ok");
