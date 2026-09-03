/**
 * Baileys multi-session manager.
 * Sessions live in data/baileys/<name>; each is a WhatsApp account.
 * Events: credentials.update, connection.update (QR / open / close),
 * messages.upsert (inbox capture -> SQLite).
 */
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const logger = require("./logger");
const store = require("./db");

const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const sessionsDir = path.join(__dirname, "..", "data", "baileys");
fs.mkdirSync(sessionsDir, { recursive: true });

/** name -> { sock, status, qr, phone } */
const sessions = new Map();

function sessionState(name) {
  return sessions.get(name) || { status: "offline", qr: null, phone: null };
}

function listSessions() {
  // union of runtime sessions and on-disk auth folders
  const names = new Set(sessions.keys());
  for (const d of fs.readdirSync(sessionsDir)) names.add(d);
  return [...names].sort().map((name) => {
    const s = sessionState(name);
    return {
      name,
      status: s.status || "offline",
      phone: s.phone || null,
      hasAuth: fs.existsSync(path.join(sessionsDir, name, "creds.json")),
    };
  });
}

async function startSession(name, { onStatus = () => {} } = {}) {
  if (sessions.has(name)) return sessionState(name);
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
  } = await import("@whiskeysockets/baileys");
  const pendingTimer = reconnectTimers.get(name);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    reconnectTimers.delete(name);
  }
  const authDir = path.join(sessionsDir, name);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ["WaCorpDashboard", "Chrome", "1.0.0"],
  });

  const state_ = { sock, status: "connecting", qr: null, phone: null };
  sessions.set(name, state_);
  const setStatus = (s) => { state_.status = s; onStatus(name, s); };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      state_.qr = await QRCode.toDataURL(u.qr);
      setStatus("qr");
    }
    if (u.connection === "open") {
      state_.qr = null;
      state_.phone = sock.user?.id?.split(":")[0] || null;
      reconnectAttempts.delete(name);
      setStatus("connected");
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      sessions.delete(name);
      if (code === DisconnectReason.loggedOut) {
        reconnectAttempts.delete(name);
        fs.rmSync(authDir, { recursive: true, force: true });
        setStatus("logged_out");
      } else {
        // Auto-reconnect with capped exponential backoff and jitter.
        const attempt = (reconnectAttempts.get(name) || 0) + 1;
        reconnectAttempts.set(name, attempt);
        const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * Math.min(1000, backoff / 2));
        const delay = Math.min(RECONNECT_MAX_MS, backoff + jitter);
        setStatus("reconnecting");
        const timer = setTimeout(() => {
          reconnectTimers.delete(name);
          startSession(name, { onStatus }).catch((e) =>
            logger.error({ err: e, session: name }, "Session reconnect failed")
          );
        }, delay);
        reconnectTimers.set(name, timer);
      }
    }
  });

  // inbox capture
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      const chatId = m.key.remoteJid || "";
      if (chatId === "status@broadcast") continue;
      const body =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        "[non-text message]";
      store.logMessage({
        session: name,
        direction: m.key.fromMe ? "out" : "in",
        chat_id: chatId,
        contact_name: m.pushName || "",
        body,
        wa_message_id: m.key.id || "",
        status: "sent",
      });
    }
  });

  return state_;
}

function getSession(name) {
  return sessions.get(name) || null;
}

async function stopSession(name) {
  const timer = reconnectTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(name);
  }
  reconnectAttempts.delete(name);
  const s = sessions.get(name);
  if (s) {
    try { await s.sock.logout(); } catch { try { s.sock.end(); } catch {} }
    sessions.delete(name);
  }
  const authDir = path.join(sessionsDir, name);
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
}

/** Send a text message; resolves after WhatsApp confirms the send. */
async function sendText(name, chatId, body) {
  const s = sessions.get(name);
  if (!s || s.status !== "connected") throw new Error(`session '${name}' not connected`);
  const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;
  const res = await s.sock.sendMessage(jid, { text: body });
  store.logMessage({
    session: name, direction: "out", chat_id: jid,
    contact_name: "", body, wa_message_id: res?.key?.id || "", status: "sent",
  });
  return res;
}

/** Restore sessions that have saved auth (called once at boot). */
async function restoreSessions() {
  for (const name of fs.readdirSync(sessionsDir)) {
    if (fs.existsSync(path.join(sessionsDir, name, "creds.json"))) {
      await startSession(name).catch((e) => logger.error({ err: e, session: name }, "Session restore failed"));
    }
  }
}

module.exports = {
  sessions, sessionState, listSessions, startSession, stopSession,
  getSession, sendText, restoreSessions,
};
