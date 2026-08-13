const fs = require("fs");
const path = require("path");
const P = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const BASE = path.resolve(process.env.SESSION_DIR || "./data/sessions");
const sessions = new Map();

fs.mkdirSync(BASE, { recursive: true });

function cleanPhone(phone) {
  return String(phone).replace(/[^\d]/g, "");
}

async function createWhatsAppSession(phone) {
  phone = cleanPhone(phone);

  if (sessions.has(phone)) {
    const current = sessions.get(phone);
    return { status: current.status, code: current.code || null };
  }

  const authPath = path.join(BASE, phone);
  fs.mkdirSync(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["HEXGATE", "Chrome", "1.0.0"],
    markOnlineOnConnect: false
  });

  const entry = { sock, status: "connecting", code: null };
  sessions.set(phone, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      entry.status = "connected";
      entry.code = null;
      console.log(`[HEXGATE] ${phone} connected`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      entry.status = "disconnected";
      entry.code = null;

      sessions.delete(phone);

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          createWhatsAppSession(phone).catch(console.error);
        }, 3000);
      }
    }
  });

  // A pairing code is requested only for a fresh/unregistered auth state.
  if (!state.creds.registered) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const code = await sock.requestPairingCode(phone);
    entry.code = code;
    entry.status = "waiting_pairing";
  } else {
    entry.status = "connected";
  }

  // Basic group moderation example: anti-link for non-admins.
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key.remoteJid?.endsWith("@g.us")) continue;
        if (msg.key.fromMe) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!/https?:\/\/|www\.|wa\.me\/|t\.me\//i.test(text)) continue;

        const group = await sock.groupMetadata(msg.key.remoteJid);
        const sender = msg.key.participant;
        const senderInfo = group.participants.find(p => p.id === sender);
        const isAdmin = ["admin", "superadmin"].includes(senderInfo?.admin);

        if (!isAdmin) {
          await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
        }
      } catch (e) {
        console.error("[ANTILINK]", e.message);
      }
    }
  });

  return { status: entry.status, code: entry.code };
}

async function getSessionStatus(phone) {
  phone = cleanPhone(phone);
  const entry = sessions.get(phone);

  if (entry) {
    return { ok: true, phone, status: entry.status, code: entry.code || null };
  }

  const authPath = path.join(BASE, phone);
  const registered = fs.existsSync(path.join(authPath, "creds.json"));

  return {
    ok: true,
    phone,
    status: registered ? "saved_session" : "not_found",
    code: null
  };
}

module.exports = { createWhatsAppSession, getSessionStatus };
