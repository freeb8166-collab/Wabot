const fs = require("fs");
const path = require("path");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const { remember, find, MEDIA_DIR } = require("./store");

const BASE = path.resolve(process.env.SESSION_DIR || "./data/sessions");
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const sessions = new Map();
const configs = new Map();

const DEFAULT_CONFIG = {
  fakeRecording: false,
  antiDelete: true,
  antiLink: true,
  antiSpam: true,
  welcome: true
};

function normalizePhone(input) {
  let raw = String(input || "").replace(/[^\d]/g, "");
  const parsed = parsePhoneNumberFromString(`+${raw}`);
  if (!parsed || !parsed.isValid()) throw new Error("Numéro WhatsApp invalide. Exemple : 2438XXXXXXXX");
  return parsed.number.slice(1);
}

function getConfig(phone) {
  if (!configs.has(phone)) configs.set(phone, { ...DEFAULT_CONFIG });
  return configs.get(phone);
}

function unwrapMessage(message) {
  let m = message;
  while (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  while (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  while (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  return m || {};
}

function extractText(message) {
  const m = unwrapMessage(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

function isLink(text) {
  return /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|telegram\.me\/)/i.test(text);
}

function isAdmin(metadata, jid) {
  const p = metadata?.participants?.find(x => x.id === jid);
  return ["admin", "superadmin"].includes(p?.admin);
}

async function saveReceivedMessage(phone, msg) {
  if (!msg.message || !msg.key.id || !msg.key.remoteJid) return;
  const m = unwrapMessage(msg.message);
  const text = extractText(msg.message);
  let type = "text";
  let mediaPath = null;
  let mimetype = null;
  let caption = null;

  try {
    if (m.imageMessage) {
      type = "image";
      mimetype = m.imageMessage.mimetype || "image/jpeg";
      caption = m.imageMessage.caption || "";
    } else if (m.videoMessage) {
      type = "video";
      mimetype = m.videoMessage.mimetype || "video/mp4";
      caption = m.videoMessage.caption || "";
    } else if (m.audioMessage) {
      type = "audio";
      mimetype = m.audioMessage.mimetype || "audio/ogg";
    } else if (m.documentMessage) {
      type = "document";
      mimetype = m.documentMessage.mimetype || "application/octet-stream";
    }

    if (["image", "video", "audio", "document"].includes(type)) {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: P({ level: "silent" }), reuploadRequest: async () => null }
      );
      const ext = type === "image" ? "jpg" : type === "video" ? "mp4" : type === "audio" ? "ogg" : "bin";
      mediaPath = path.join(MEDIA_DIR, `${phone}-${Date.now()}-${msg.key.id}.${ext}`);
      fs.writeFileSync(mediaPath, buffer);
    }
  } catch (e) {
    console.warn("[HEXGATE] media archive failed:", e.message);
  }

  remember(phone, {
    id: msg.key.id,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    fromMe: msg.key.fromMe,
    type,
    text,
    mediaPath,
    mimetype,
    caption
  });
}

async function restoreDeleted(phone, sock, revokedMessage) {
  const jid = revokedMessage.key.remoteJid;
  const id = revokedMessage.key.id;
  const saved = find(phone, jid, id);
  if (!saved) return;

  try {
    let content;
    if (saved.type === "image" && saved.mediaPath && fs.existsSync(saved.mediaPath)) {
      content = { image: fs.readFileSync(saved.mediaPath), caption: saved.caption || "" };
    } else if (saved.type === "video" && saved.mediaPath && fs.existsSync(saved.mediaPath)) {
      content = { video: fs.readFileSync(saved.mediaPath), caption: saved.caption || "" };
    } else if (saved.type === "audio" && saved.mediaPath && fs.existsSync(saved.mediaPath)) {
      content = { audio: fs.readFileSync(saved.mediaPath), mimetype: saved.mimetype || "audio/ogg", ptt: false };
    } else if (saved.type === "document" && saved.mediaPath && fs.existsSync(saved.mediaPath)) {
      content = { document: fs.readFileSync(saved.mediaPath), mimetype: saved.mimetype || "application/octet-stream", fileName: "restored-file" };
    } else {
      content = { text: saved.text || "[Message supprimé — contenu texte vide]" };
    }

    await sock.sendMessage(jid, {
      ...content,
      contextInfo: {
        externalAdReply: {
          title: "HEXGATE • Anti-Delete",
          body: "Contenu restauré après suppression",
          mediaType: 1
        }
      }
    });
  } catch (e) {
    console.error("[HEXGATE] restore failed:", e.message);
  }
}

function formatCode(code) {
  return code ? code.match(/.{1,4}/g)?.join("-") : null;
}

async function createSession(phoneInput) {
  const phone = normalizePhone(phoneInput);

  if (sessions.has(phone)) {
    const e = sessions.get(phone);
    return { phone, status: e.status, code: e.code ? formatCode(e.code) : null };
  }

  const authPath = path.join(BASE, phone);
  fs.mkdirSync(authPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  // Keep the socket configuration conservative for pairing reliability.
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log("[HEXGATE] WhatsApp Web version:", version.join("."));
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "info" }),
    browser: ["HEXGATE", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    generateHighQualityLinkPreview: false
  });

  const entry = { sock, status: "connecting", code: null, phone };
  sessions.set(phone, entry);
  sock.ev.on("creds.update", saveCreds);

  let pairingRequested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        // WhatsApp expects digits only, including country code.
        const code = await sock.requestPairingCode(phone);
        entry.code = code;
        entry.status = "waiting_pairing";
        console.log(`[HEXGATE] Pairing ${phone}: ${formatCode(code)}`);
      } catch (e) {
        entry.status = "pairing_error";
        entry.error = e.message;
        pairingRequested = false;
        console.error("[HEXGATE] Pairing error:", e);
      }
    }

    if (connection === "open") {
      entry.status = "connected";
      entry.code = null;
      console.log(`[HEXGATE] ${phone} connected`);

      // Send a confirmation to the connected WhatsApp account.
      try {
        await sock.sendMessage(`${phone}@s.whatsapp.net`, {
          text: "🟢 *HEXGATE CONNECTÉ*\n\nVotre bot WhatsApp est maintenant connecté avec succès.\n\nTapez *.menu* pour afficher les commandes."
        });
      } catch (e) {
        console.warn("[HEXGATE] connection confirmation failed:", e.message);
      }
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      entry.status = "disconnected";
      entry.code = null;

      if (code === DisconnectReason.loggedOut) {
        sessions.delete(phone);
        console.log(`[HEXGATE] ${phone} logged out`);
      } else {
        sessions.delete(phone);
        setTimeout(() => {
          createSession(phone).catch(err => console.error("[HEXGATE] reconnect:", err.message));
        }, 4000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key.remoteJid) continue;

        const cfg = getConfig(phone);

        // Archive incoming content for anti-delete restoration.
        if (!msg.key.fromMe && cfg.antiDelete) {
          await saveReceivedMessage(phone, msg);
        }

        if (msg.key.fromMe) {
          const text = extractText(msg.message);
          if (text.startsWith(".")) await handleCommand(phone, sock, msg, text, cfg);
          continue;
        }

        const jid = msg.key.remoteJid;

        // Fake recording mode: show "recording audio" presence when a message arrives.
        if (cfg.fakeRecording) {
          try {
            await sock.sendPresenceUpdate("recording", jid);
            setTimeout(() => sock.sendPresenceUpdate("paused", jid).catch(() => {}), 2500);
          } catch {}
        }
        if (!jid.endsWith("@g.us")) continue;

        const text = extractText(msg.message);
        const metadata = await sock.groupMetadata(jid);
        const sender = msg.key.participant || msg.key.remoteJid;
        const admin = isAdmin(metadata, sender);

        if (cfg.antiLink && isLink(text) && !admin) {
          await sock.sendMessage(jid, { delete: msg.key });
          await sock.sendMessage(jid, { text: `🚫 @${sender.split("@")[0]} lien supprimé.`, mentions: [sender] });
          continue;
        }

        if (cfg.antiSpam && text.length > 1500 && !admin) {
          await sock.sendMessage(jid, { delete: msg.key });
          continue;
        }

        if (cfg.welcome && msg.message?.protocolMessage) {
          // Reserved for group participant events; actual welcome handling can be expanded.
        }
      } catch (e) {
        console.error("[HEXGATE] message handler:", e.message);
      }
    }
  });

  sock.ev.on("messages.update", async updates => {
    const cfg = getConfig(phone);
    if (!cfg.antiDelete) return;

    for (const update of updates) {
      const protocol = update.update?.message?.protocolMessage;
      if (protocol?.type === 0) {
        await restoreDeleted(phone, sock, {
          key: {
            remoteJid: update.key.remoteJid,
            id: protocol.key?.id || update.key.id
          }
        });
      }
    }
  });

  return { phone, status: entry.status, code: null };
}

async function handleCommand(phone, sock, msg, raw, cfg) {
  const jid = msg.key.remoteJid;
  const args = raw.trim().split(/\s+/);
  const command = args[0].toLowerCase();
  const value = args[1]?.toLowerCase();

  const group = jid.endsWith("@g.us") ? await sock.groupMetadata(jid).catch(() => null) : null;
  const sender = msg.key.participant || msg.key.remoteJid;
  const admin = !group || isAdmin(group, sender);

  const requireAdmin = async () => {
    if (!admin) {
      await sock.sendMessage(jid, { text: "⛔ Commande réservée aux administrateurs." });
      return false;
    }
    return true;
  };

  switch (command) {
    // 1
    case ".menu":
      await sock.sendMessage(jid, { text:
`╭━━━〔 ⚡ HEXGATE ⚡ 〕━━━╮
┃  CYBERPUNK BOT MENU
╰━━━━━━━━━━━━━━━━━━━━━━╯

🛡️ MODÉRATION
• .fakerecording on/off
• .antidelete on/off
• .antilink on/off
• .antispam on/off
• .welcome on/off

👑 OUTILS
• .tagall
• .groupinfo
• .admins
• .ping
• .botstatus
• .menu

HEXGATE • Secure Group Automation` });
      break;

    // 2
    case ".fakerecording":
      if (!(await requireAdmin())) return;
      if (!["on","off"].includes(value)) {
        await sock.sendMessage(jid, { text: `Usage: .fakerecording on/off\nÉtat actuel: ${cfg.fakeRecording ? "ON" : "OFF"}` });
        return;
      }
      cfg.fakeRecording = value === "on";
      await sock.sendPresenceUpdate(cfg.fakeRecording ? "recording" : "paused", jid);
      await sock.sendMessage(jid, { text: `🎙️ Fake Recording: ${cfg.fakeRecording ? "ON" : "OFF"}` });
      break;

    // 3
    case ".antidelete":
      if (!(await requireAdmin())) return;
      if (!["on","off"].includes(value)) {
        await sock.sendMessage(jid, { text: `Usage: .antidelete on/off\nÉtat actuel: ${cfg.antiDelete ? "ON" : "OFF"}` });
        return;
      }
      cfg.antiDelete = value === "on";
      await sock.sendMessage(jid, { text: `🧬 Anti-Delete: ${cfg.antiDelete ? "ON" : "OFF"}\n${cfg.antiDelete ? "Les nouveaux contenus reçus seront archivés pour restauration." : "L'archivage est désactivé."}` });
      break;

    // 4
    case ".antilink":
      if (!(await requireAdmin())) return;
      if (!["on","off"].includes(value)) {
        await sock.sendMessage(jid, { text: `Usage: .antilink on/off\nÉtat actuel: ${cfg.antiLink ? "ON" : "OFF"}` });
        return;
      }
      cfg.antiLink = value === "on";
      await sock.sendMessage(jid, { text: `🔗 Anti-Link: ${cfg.antiLink ? "ON" : "OFF"}` });
      break;

    // 5
    case ".antispam":
      if (!(await requireAdmin())) return;
      if (!["on","off"].includes(value)) {
        await sock.sendMessage(jid, { text: `Usage: .antispam on/off\nÉtat actuel: ${cfg.antiSpam ? "ON" : "OFF"}` });
        return;
      }
      cfg.antiSpam = value === "on";
      await sock.sendMessage(jid, { text: `🛡️ Anti-Spam: ${cfg.antiSpam ? "ON" : "OFF"}` });
      break;

    // 6
    case ".welcome":
      if (!(await requireAdmin())) return;
      if (!["on","off"].includes(value)) {
        await sock.sendMessage(jid, { text: `Usage: .welcome on/off\nÉtat actuel: ${cfg.welcome ? "ON" : "OFF"}` });
        return;
      }
      cfg.welcome = value === "on";
      await sock.sendMessage(jid, { text: `👋 Welcome: ${cfg.welcome ? "ON" : "OFF"}` });
      break;

    // 7
    case ".tagall":
      if (!(await requireAdmin())) return;
      if (!group) return;
      const mentions = group.participants.map(p => p.id);
      await sock.sendMessage(jid, {
        text: `⚡ HEXGATE TAGALL\n\n${mentions.map(x => `@${x.split("@")[0]}`).join(" ")}`,
        mentions
      });
      break;

    // 8
    case ".groupinfo":
      if (!group) {
        await sock.sendMessage(jid, { text: "Cette commande doit être utilisée dans un groupe." });
        return;
      }
      await sock.sendMessage(jid, {
        text: `╭─〔 GROUP INFO 〕─╮
Nom: ${group.subject}
Membres: ${group.participants.length}
Créateur: ${group.owner ? group.owner.split("@")[0] : "inconnu"}
HEXGATE: ${phone}`
      });
      break;

    // 9
    case ".admins":
      if (!group) return;
      const admins = group.participants.filter(p => ["admin","superadmin"].includes(p.admin));
      await sock.sendMessage(jid, {
        text: `👑 ADMINS\n\n${admins.map(x => `@${x.id.split("@")[0]}`).join("\n")}`,
        mentions: admins.map(x => x.id)
      });
      break;

    // 10
    case ".ping":
      await sock.sendMessage(jid, { text: `⚡ PONG\nHEXGATE online\nUptime: ${Math.floor(process.uptime())}s` });
      break;

    // 11 (10th user command, menu excluded)
    case ".botstatus":
      await sock.sendMessage(jid, {
        text: `╭─〔 HEXGATE STATUS 〕─╮
WhatsApp: CONNECTED
Anti-Link: ${cfg.antiLink ? "ON" : "OFF"}
Anti-Spam: ${cfg.antiSpam ? "ON" : "OFF"}
Anti-Delete: ${cfg.antiDelete ? "ON" : "OFF"}
Fake Recording: ${cfg.fakeRecording ? "ON" : "OFF"}
Welcome: ${cfg.welcome ? "ON" : "OFF"}
Uptime: ${Math.floor(process.uptime())}s`
      });
      break;
  }
}

async function getSessionStatus(phoneInput) {
  const phone = normalizePhone(phoneInput);
  const e = sessions.get(phone);
  if (e) return { ok: true, phone, status: e.status, code: e.code ? formatCode(e.code) : null, error: e.error || null };

  const authPath = path.join(BASE, phone);
  return {
    ok: true,
    phone,
    status: fs.existsSync(path.join(authPath, "creds.json")) ? "saved_session" : "not_found",
    code: null
  };
}

function listSessions() {
  return [...sessions.values()].map(e => ({
    phone: e.phone,
    status: e.status,
    code: e.code ? formatCode(e.code) : null
  }));
}

async function logoutSession(phoneInput) {
  const phone = normalizePhone(phoneInput);
  const e = sessions.get(phone);
  if (e) {
    try { await e.sock.logout(); } catch {}
    sessions.delete(phone);
  }
}

module.exports = {
  createSession,
  getSessionStatus,
  listSessions,
  logoutSession
};
