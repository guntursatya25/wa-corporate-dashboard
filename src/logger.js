const path = require("path");
const fs = require("fs");
const pino = require("pino");

const isProduction = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");
const logFile = process.env.LOG_FILE || path.join(process.cwd(), "logs", "app.log");

let destination;
if (isProduction) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  destination = pino.destination({ dest: logFile, sync: false });
}

const logger = pino({
  level,
  base: { service: "wa-corporate-dashboard" },
  timestamp: pino.stdTimeFunctions.isoTime,
}, destination);

module.exports = logger;