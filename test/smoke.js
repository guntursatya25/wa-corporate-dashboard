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
const smokeContact = store.getContactByPhone("999999999999");
assert.ok(smokeContact);
assert.ok(store.listContacts().some((row) => row.phone === "999999999999"));

store.createGroup("Smoke Group");
const group = store.listGroups().find((row) => row.name === "Smoke Group");
assert.ok(group);
store.addContactToGroup(smokeContact.id, group.id);
assert.strictEqual(store.listContactsByGroup(group.id)[0].phone, "999999999999");
assert.strictEqual(store.listContacts()[0].group_names, "Smoke Group");
assert.strictEqual(store.exportContacts()[0].groups, "Smoke Group");

store.deleteGroup(group.id);
store.deleteContact(smokeContact.id);
console.log("smoke ok");
