"use strict";

/*
 * ============================================================
 * HEXGATE - WhatsApp Session Manager
 * ============================================================
 *
 * Fichier :
 * backend/src/baileys/sessionManager.js
 *
 * Fonctions :
 * - Pairing Code WhatsApp
 * - Sessions persistantes
 * - Reconnexion automatique
 * - Anti-link
 * - Anti-spam basique
 * - Fake recording
 * - Anti-delete texte / image / vidéo / audio / document
 * - .menu
 * - .fakerecording
 * - .antidelete
 * - .antilink
 * - .antispam
 * - .welcome
 * - .tagall
 * - .groupinfo
 * - .admins
 * - .ping
 * - .botstatus
 *
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const P = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

/* ============================================================
   DIRECTORIES
============================================================ */

const ROOT_DIR = path.resolve(
  process.env.HEXGATE_DATA_DIR || "./data"
);

const SESSION_DIR = path.join(
  ROOT_DIR,
  "sessions"
);

const MEDIA_DIR = path.join(
  ROOT_DIR,
  "media"
);

const MESSAGE_DB = path.join(
  ROOT_DIR,
  "messages.json"
);

fs.mkdirSync(
  SESSION_DIR,
  { recursive: true }
);

fs.mkdirSync(
  MEDIA_DIR,
  { recursive: true }
);

/* ============================================================
   LOGGER
============================================================ */

const logger = P({
  level:
    process.env.LOG_LEVEL || "info"
});

/* ============================================================
   MEMORY
============================================================ */

const sessions = new Map();
const startingSessions = new Map();

/* ============================================================
   DEFAULT CONFIG
============================================================ */

const DEFAULT_CONFIG = {
  fakeRecording: false,
  antiDelete: true,
  antiLink: true,
  antiSpam: true,
  welcome: true
};

const configs = new Map();

/* ============================================================
   MESSAGE DATABASE
============================================================ */

let messageDatabase = {};

try {
  if (fs.existsSync(MESSAGE_DB)) {
    const raw =
      fs.readFileSync(
        MESSAGE_DB,
        "utf8"
      );

    messageDatabase =
      JSON.parse(raw || "{}");
  }
} catch (error) {
  logger.warn(
    {
      error: error.message
    },
    "[HEXGATE] Impossible de charger messages.json"
  );

  messageDatabase = {};
}

/* ============================================================
   SAVE DATABASE
============================================================ */

function saveMessageDatabase() {
  try {
    fs.writeFileSync(
      MESSAGE_DB,
      JSON.stringify(
        messageDatabase,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    logger.error(
      {
        error: error.message
      },
      "[HEXGATE] Erreur sauvegarde messages"
    );
  }
}

/* ============================================================
   PHONE NORMALIZATION
============================================================ */

function normalizePhone(input) {
  const phone =
    String(input || "")
      .replace(/\D/g, "");

  if (
    !phone ||
    phone.length < 8 ||
    phone.length > 15
  ) {
    throw new Error(
      "Numéro invalide. Utilisez le format international sans +. Exemple : 2438XXXXXXXX"
    );
  }

  return phone;
}

/* ============================================================
   FORMAT PAIRING CODE
============================================================ */

function formatPairingCode(code) {
  if (!code) {
    return null;
  }

  const clean =
    String(code)
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();

  if (!clean) {
    return null;
  }

  const parts =
    clean.match(/.{1,4}/g);

  return parts
    ? parts.join("-")
    : clean;
}

/* ============================================================
   CONFIG
============================================================ */

function getConfig(phone) {
  if (!configs.has(phone)) {
    configs.set(
      phone,
      {
        ...DEFAULT_CONFIG
      }
    );
  }

  return configs.get(phone);
}

/* ============================================================
   MESSAGE UNWRAPPER
============================================================ */

function unwrapMessage(message) {
  let current = message;

  if (!current) {
    return {};
  }

  while (
    current.ephemeralMessage &&
    current.ephemeralMessage.message
  ) {
    current =
      current.ephemeralMessage.message;
  }

  while (
    current.viewOnceMessage &&
    current.viewOnceMessage.message
  ) {
    current =
      current.viewOnceMessage.message;
  }

  while (
    current.viewOnceMessageV2 &&
    current.viewOnceMessageV2.message
  ) {
    current =
      current.viewOnceMessageV2.message;
  }

  while (
    current.viewOnceMessageV2Extension &&
    current.viewOnceMessageV2Extension.message
  ) {
    current =
      current.viewOnceMessageV2Extension.message;
  }

  return current || {};
}

/* ============================================================
   EXTRACT TEXT
============================================================ */

function extractText(message) {
  const m =
    unwrapMessage(message);

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

/* ============================================================
   LINK DETECTION
============================================================ */

/*
 * IMPORTANT :
 * Pas de flag /x ici.
 * JavaScript ne supporte pas le flag x.
 */

function containsLink(text) {
  const value =
    String(text || "");

  return /https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|telegram\.me\//i.test(
    value
  );
}

/* ============================================================
   GROUP ADMIN
============================================================ */

function isAdmin(
  metadata,
  jid
) {
  if (
    !metadata ||
    !jid
  ) {
    return false;
  }

  const participant =
    metadata.participants?.find(
      item =>
        item.id === jid ||
        item.jid === jid
    );

  if (!participant) {
    return false;
  }

  return (
    participant.admin === "admin" ||
    participant.admin === "superadmin"
  );
}

/* ============================================================
   GET DISCONNECT CODE
============================================================ */

function getDisconnectCode(
  lastDisconnect
) {
  return (
    lastDisconnect?.error?.output?.statusCode ||
    lastDisconnect?.error?.statusCode ||
    null
  );
}

/* ============================================================
   MESSAGE DATABASE KEY
============================================================ */

function messageKey(
  phone,
  jid,
  id
) {
  return `${phone}:${jid}:${id}`;
}

/* ============================================================
   SAVE MESSAGE
============================================================ */

async function archiveMessage(
  phone,
  message
) {
  if (
    !message ||
    !message.key ||
    !message.message
  ) {
    return;
  }

  const jid =
    message.key.remoteJid;

  const id =
    message.key.id;

  if (!jid || !id) {
    return;
  }

  const content =
    unwrapMessage(
      message.message
    );

  let type = "text";
  let text =
    extractText(
      message.message
    );

  let mediaPath = null;
  let mimetype = null;
  let fileName = null;
  let caption = null;

  /* ----------------------------------------------------------
     IMAGE
  ---------------------------------------------------------- */

  if (
    content.imageMessage
  ) {
    type = "image";

    caption =
      content.imageMessage.caption ||
      "";

    mimetype =
      content.imageMessage.mimetype ||
      "image/jpeg";
  }

  /* ----------------------------------------------------------
     VIDEO
  ---------------------------------------------------------- */

  else if (
    content.videoMessage
  ) {
    type = "video";

    caption =
      content.videoMessage.caption ||
      "";

    mimetype =
      content.videoMessage.mimetype ||
      "video/mp4";
  }

  /* ----------------------------------------------------------
     AUDIO
  ---------------------------------------------------------- */

  else if (
    content.audioMessage
  ) {
    type = "audio";

    mimetype =
      content.audioMessage.mimetype ||
      "audio/ogg";
  }

  /* ----------------------------------------------------------
     DOCUMENT
  ---------------------------------------------------------- */

  else if (
    content.documentMessage
  ) {
    type = "document";

    mimetype =
      content.documentMessage.mimetype ||
      "application/octet-stream";

    fileName =
      content.documentMessage.fileName ||
      "HEXGATE-file";
  }

  /* ----------------------------------------------------------
     DOWNLOAD MEDIA
  ---------------------------------------------------------- */

  if (
    type !== "text"
  ) {
    try {
      const buffer =
        await downloadMediaMessage(
          message,
          "buffer",
          {},
          {
            logger,
            reuploadRequest:
              async mediaMessage =>
                undefined
          }
        );

      if (
        buffer &&
        Buffer.isBuffer(buffer)
      ) {
        let extension =
          "bin";

        if (
          type === "image"
        ) {
          extension = "jpg";
        }

        if (
          type === "video"
        ) {
          extension = "mp4";
        }

        if (
          type === "audio"
        ) {
          extension = "ogg";
        }

        if (
          type === "document"
        ) {
          extension = "bin";
        }

        const filename =
          `${Date.now()}-${id}.${extension}`;

        mediaPath =
          path.join(
            MEDIA_DIR,
            filename
          );

        fs.writeFileSync(
          mediaPath,
          buffer
        );
      }
    } catch (error) {
      logger.warn(
        {
          error: error.message
        },
        "[HEXGATE] Téléchargement média impossible"
      );
    }
  }

  const key =
    messageKey(
      phone,
      jid,
      id
    );

  messageDatabase[key] = {
    phone,
    jid,
    id,

    participant:
      message.key.participant ||
      null,

    fromMe:
      Boolean(
        message.key.fromMe
      ),

    type,

    text,

    caption,

    mimetype,

    fileName,

    mediaPath,

    createdAt:
      Date.now()
  };

  /*
   * Évite une base infinie.
   * On conserve les 1000 derniers messages.
   */

  const keys =
    Object.keys(
      messageDatabase
    );

  if (
    keys.length > 1000
  ) {
    const sorted =
      keys.sort(
        (a, b) =>
          (
            messageDatabase[a]
              ?.createdAt || 0
          ) -
          (
            messageDatabase[b]
              ?.createdAt || 0
          )
      );

    const removeCount =
      keys.length - 1000;

    for (
      let i = 0;
      i < removeCount;
      i++
    ) {
      delete messageDatabase[
        sorted[i]
      ];
    }
  }

  saveMessageDatabase();
}

/* ============================================================
   FIND ARCHIVED MESSAGE
============================================================ */

function findArchivedMessage(
  phone,
  jid,
  id
) {
  return (
    messageDatabase[
      messageKey(
        phone,
        jid,
        id
      )
    ] || null
  );
}

/* ============================================================
   RESTORE DELETED MESSAGE
============================================================ */

async function restoreDeletedMessage(
  phone,
  sock,
  key
) {
  if (
    !key ||
    !key.remoteJid ||
    !key.id
  ) {
    return;
  }

  const saved =
    findArchivedMessage(
      phone,
      key.remoteJid,
      key.id
    );

  if (!saved) {
    logger.info(
      `[HEXGATE] Message supprimé non trouvé : ${key.id}`
    );

    return;
  }

  const jid =
    key.remoteJid;

  try {
    /* --------------------------------------------------------
       IMAGE
    -------------------------------------------------------- */

    if (
      saved.type === "image" &&
      saved.mediaPath &&
      fs.existsSync(
        saved.mediaPath
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          image:
            fs.readFileSync(
              saved.mediaPath
            ),

          caption:
            `♻️ *MESSAGE SUPPRIMÉ RESTAURÉ*\n\n${saved.caption || ""}`
        }
      );

      return;
    }

    /* --------------------------------------------------------
       VIDEO
    -------------------------------------------------------- */

    if (
      saved.type === "video" &&
      saved.mediaPath &&
      fs.existsSync(
        saved.mediaPath
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          video:
            fs.readFileSync(
              saved.mediaPath
            ),

          caption:
            `♻️ *MESSAGE SUPPRIMÉ RESTAURÉ*\n\n${saved.caption || ""}`
        }
      );

      return;
    }

    /* --------------------------------------------------------
       AUDIO
    -------------------------------------------------------- */

    if (
      saved.type === "audio" &&
      saved.mediaPath &&
      fs.existsSync(
        saved.mediaPath
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          audio:
            fs.readFileSync(
              saved.mediaPath
            ),

          mimetype:
            saved.mimetype ||
            "audio/ogg",

          ptt: false
        }
      );

      return;
    }

    /* --------------------------------------------------------
       DOCUMENT
    -------------------------------------------------------- */

    if (
      saved.type === "document" &&
      saved.mediaPath &&
      fs.existsSync(
        saved.mediaPath
      )
    ) {
      await sock.sendMessage(
        jid,
        {
          document:
            fs.readFileSync(
              saved.mediaPath
            ),

          mimetype:
            saved.mimetype ||
            "application/octet-stream",

          fileName:
            saved.fileName ||
            "restored-file"
        }
      );

      return;
    }

    /* --------------------------------------------------------
       TEXT
    -------------------------------------------------------- */

    await sock.sendMessage(
      jid,
      {
        text:
          `♻️ *MESSAGE SUPPRIMÉ RESTAURÉ*\n\n${saved.text || "[contenu indisponible]"}`
      }
    );

  } catch (error) {
    logger.error(
      {
        error: error.message
      },
      "[HEXGATE] Erreur restauration message"
    );
  }
}

/* ============================================================
   SEND COMMAND RESPONSE
============================================================ */

async function sendText(
  sock,
  jid,
  text,
  mentions
) {
  const content = {
    text
  };

  if (
    Array.isArray(mentions) &&
    mentions.length > 0
  ) {
    content.mentions =
      mentions;
  }

  await sock.sendMessage(
    jid,
    content
  );
}

/* ============================================================
   COMMAND HANDLER
============================================================ */

async function handleCommand(
  phone,
  sock,
  message,
  commandText
) {
  const jid =
    message.key.remoteJid;

  if (!jid) {
    return;
  }

  const parts =
    commandText
      .trim()
      .split(/\s+/);

  const command =
    (
      parts[0] || ""
    ).toLowerCase();

  const argument =
    (
      parts[1] || ""
    ).toLowerCase();

  const config =
    getConfig(phone);

  let metadata = null;

  if (
    jid.endsWith("@g.us")
  ) {
    try {
      metadata =
        await sock.groupMetadata(
          jid
        );
    } catch {}
  }

  const sender =
    message.key.participant ||
    jid;

  const admin =
    !metadata ||
    isAdmin(
      metadata,
      sender
    );

  async function requireAdmin() {
    if (admin) {
      return true;
    }

    await sendText(
      sock,
      jid,
      "⛔ Cette commande est réservée aux administrateurs."
    );

    return false;
  }

  /* ==========================================================
     MENU
  ========================================================== */

  if (
    command === ".menu"
  ) {
    await sendText(
      sock,
      jid,
`╭━━━〔 ⚡ HEXGATE ⚡ 〕━━━╮
┃      CYBERPUNK BOT
╰━━━━━━━━━━━━━━━━━━━━━━╯

🛡️ MODÉRATION

.fakerecording on/off
.antidelete on/off
.antilink on/off
.antispam on/off
.welcome on/off

👑 OUTILS

.tagall
.groupinfo
.admins
.ping
.botstatus

⚡ HEXGATE ONLINE`
    );

    return;
  }

  /* ==========================================================
     FAKE RECORDING
  ========================================================== */

  if (
    command ===
    ".fakerecording"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (
      argument !== "on" &&
      argument !== "off"
    ) {
      await sendText(
        sock,
        jid,
        `🎙️ Usage : .fakerecording on/off\nÉtat actuel : ${config.fakeRecording ? "ON" : "OFF"}`
      );

      return;
    }

    config.fakeRecording =
      argument === "on";

    await sendText(
      sock,
      jid,
      `🎙️ Fake Recording : ${config.fakeRecording ? "ON" : "OFF"}`
    );

    return;
  }

  /* ==========================================================
     ANTI DELETE
  ========================================================== */

  if (
    command ===
    ".antidelete"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (
      argument !== "on" &&
      argument !== "off"
    ) {
      await sendText(
        sock,
        jid,
        `♻️ Usage : .antidelete on/off\nÉtat actuel : ${config.antiDelete ? "ON" : "OFF"}`
      );

      return;
    }

    config.antiDelete =
      argument === "on";

    await sendText(
      sock,
      jid,
      `♻️ Anti-Delete : ${config.antiDelete ? "ON" : "OFF"}`
    );

    return;
  }

  /* ==========================================================
     ANTI LINK
  ========================================================== */

  if (
    command === ".antilink"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (
      argument !== "on" &&
      argument !== "off"
    ) {
      await sendText(
        sock,
        jid,
        `🔗 Usage : .antilink on/off\nÉtat actuel : ${config.antiLink ? "ON" : "OFF"}`
      );

      return;
    }

    config.antiLink =
      argument === "on";

    await sendText(
      sock,
      jid,
      `🔗 Anti-Link : ${config.antiLink ? "ON" : "OFF"}`
    );

    return;
  }

  /* ==========================================================
     ANTI SPAM
  ========================================================== */

  if (
    command === ".antispam"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (
      argument !== "on" &&
      argument !== "off"
    ) {
      await sendText(
        sock,
        jid,
        `🛡️ Usage : .antispam on/off\nÉtat actuel : ${config.antiSpam ? "ON" : "OFF"}`
      );

      return;
    }

    config.antiSpam =
      argument === "on";

    await sendText(
      sock,
      jid,
      `🛡️ Anti-Spam : ${config.antiSpam ? "ON" : "OFF"}`
    );

    return;
  }

  /* ==========================================================
     WELCOME
  ========================================================== */

  if (
    command === ".welcome"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (
      argument !== "on" &&
      argument !== "off"
    ) {
      await sendText(
        sock,
        jid,
        `👋 Usage : .welcome on/off\nÉtat actuel : ${config.welcome ? "ON" : "OFF"}`
      );

      return;
    }

    config.welcome =
      argument === "on";

    await sendText(
      sock,
      jid,
      `👋 Welcome : ${config.welcome ? "ON" : "OFF"}`
    );

    return;
  }

  /* ==========================================================
     TAGALL
  ========================================================== */

  if (
    command === ".tagall"
  ) {
    if (
      !(await requireAdmin())
    ) {
      return;
    }

    if (!metadata) {
      await sendText(
        sock,
        jid,
        "⚠️ Cette commande fonctionne uniquement dans un groupe."
      );

      return;
    }

    const participants =
      metadata.participants || [];

    const mentions =
      participants.map(
        participant =>
          participant.id
      );

    const text =
      participants
        .map(
          participant =>
            `@${participant.id.split("@")[0]}`
        )
        .join(" ");

    await sendText(
      sock,
      jid,
      `⚡ *HEXGATE TAGALL*\n\n${text}`,
      mentions
    );

    return;
  }

  /* ==========================================================
     GROUP INFO
  ========================================================== */

  if (
    command === ".groupinfo"
  ) {
    if (!metadata) {
      await sendText(
        sock,
        jid,
        "⚠️ Cette commande fonctionne uniquement dans un groupe."
      );

      return;
    }

    await sendText(
      sock,
      jid,
`╭━━〔 GROUP INFO 〕━━╮

📌 Nom :
${metadata.subject}

👥 Membres :
${metadata.participants.length}

🤖 HEXGATE :
ONLINE

╰━━━━━━━━━━━━━━━━━━╯`
    );

    return;
  }

  /* ==========================================================
     ADMINS
  ========================================================== */

  if (
    command === ".admins"
  ) {
    if (!metadata) {
      await sendText(
        sock,
        jid,
        "⚠️ Cette commande fonctionne uniquement dans un groupe."
      );

      return;
    }

    const admins =
      metadata.participants.filter(
        participant =>
          participant.admin ===
            "admin" ||
          participant.admin ===
            "superadmin"
      );

    const mentions =
      admins.map(
        participant =>
          participant.id
      );

    const text =
      admins
        .map(
          participant =>
            `👑 @${participant.id.split("@")[0]}`
        )
        .join("\n");

    await sendText(
      sock,
      jid,
      `👑 *ADMINISTRATEURS*\n\n${text || "Aucun administrateur trouvé."}`,
      mentions
    );

    return;
  }

  /* ==========================================================
     PING
  ========================================================== */

  if (
    command === ".ping"
  ) {
    const uptime =
      Math.floor(
        process.uptime()
      );

    await sendText(
      sock,
      jid,
      `⚡ *PONG*\n\nHEXGATE : ONLINE\nUptime : ${uptime}s`
    );

    return;
  }

  /* ==========================================================
     BOT STATUS
  ========================================================== */

  if (
    command === ".botstatus"
  ) {
    await sendText(
      sock,
      jid,
`╭━━〔 HEXGATE STATUS 〕━━╮

🟢 WhatsApp : CONNECTED

🔗 Anti-Link :
${config.antiLink ? "ON" : "OFF"}

♻️ Anti-Delete :
${config.antiDelete ? "ON" : "OFF"}

🛡️ Anti-Spam :
${config.antiSpam ? "ON" : "OFF"}

🎙️ Fake Recording :
${config.fakeRecording ? "ON" : "OFF"}

👋 Welcome :
${config.welcome ? "ON" : "OFF"}

⏱️ Uptime :
${Math.floor(process.uptime())}s

╰━━━━━━━━━━━━━━━━━━━━━━╯`
    );

    return;
  }
}

/* ============================================================
   MESSAGE HANDLERS
============================================================ */

function attachMessageHandlers(
  phone,
  sock
) {
  const entry =
    sessions.get(phone);

  if (
    entry?.messageHandlersAttached
  ) {
    return;
  }

  if (entry) {
    entry.messageHandlersAttached =
      true;
  }

  /* ==========================================================
     NEW MESSAGES
  ========================================================== */

  sock.ev.on(
    "messages.upsert",
    async ({
      messages,
      type
    }) => {
      if (
        type !== "notify"
      ) {
        return;
      }

      for (
        const message of messages
      ) {
        try {
          if (
            !message?.message ||
            !message?.key
          ) {
            continue;
          }

          const jid =
            message.key.remoteJid;

          if (!jid) {
            continue;
          }

          const config =
            getConfig(phone);

          /* --------------------------------------------------
             ARCHIVE POUR ANTI DELETE
          -------------------------------------------------- */

          if (
            config.antiDelete &&
            !message.key.fromMe
          ) {
            await archiveMessage(
              phone,
              message
            );
          }

          /* --------------------------------------------------
             COMMANDES
          -------------------------------------------------- */

          if (
            message.key.fromMe
          ) {
            const text =
              extractText(
                message.message
              );

            if (
              text.startsWith(".")
            ) {
              await handleCommand(
                phone,
                sock,
                message,
                text
              );
            }

            continue;
          }

          /* --------------------------------------------------
             FAKE RECORDING
          -------------------------------------------------- */

          if (
            config.fakeRecording
          ) {
            try {
              await sock.sendPresenceUpdate(
                "recording",
                jid
              );

              setTimeout(
                async () => {
                  try {
                    await sock.sendPresenceUpdate(
                      "paused",
                      jid
                    );
                  } catch {}
                },
                2500
              );
            } catch {}
          }

          /* --------------------------------------------------
             GROUP ONLY
          -------------------------------------------------- */

          if (
            !jid.endsWith("@g.us")
          ) {
            continue;
          }

          let metadata = null;

          try {
            metadata =
              await sock.groupMetadata(
                jid
              );
          } catch {
            continue;
          }

          if (!metadata) {
            continue;
          }

          const sender =
            message.key.participant ||
            jid;

          const admin =
            isAdmin(
              metadata,
              sender
            );

          const text =
            extractText(
              message.message
            );

          /* --------------------------------------------------
             ANTI LINK
          -------------------------------------------------- */

          if (
            config.antiLink &&
            containsLink(text) &&
            !admin
          ) {
            try {
              await sock.sendMessage(
                jid,
                {
                  delete:
                    message.key
                }
              );
            } catch {
              /*
               * Si WhatsApp refuse la suppression,
               * on continue sans faire planter le bot.
               */
            }

            await sendText(
              sock,
              jid,
              `🚫 @${sender.split("@")[0]} lien supprimé.`,
              [sender]
            );

            continue;
          }

          /* --------------------------------------------------
             ANTI SPAM
          -------------------------------------------------- */

          if (
            config.antiSpam &&
            !admin &&
            text.length > 1500
          ) {
            try {
              await sock.sendMessage(
                jid,
                {
                  delete:
                    message.key
                }
              );
            } catch {}

            continue;
          }
        } catch (error) {
          logger.error(
            {
              error: error.message
            },
            "[HEXGATE] Message handler error"
          );
        }
      }
    }
  );

  /* ==========================================================
     MESSAGE DELETED
  ========================================================== */

  sock.ev.on(
    "messages.delete",
    async event => {
      try {
        const config =
          getConfig(phone);

        if (
          !config.antiDelete
        ) {
          return;
        }

        if (
          !event ||
          !event.keys
        ) {
          return;
        }

        for (
          const key of event.keys
        ) {
          await restoreDeletedMessage(
            phone,
            sock,
            key
          );
        }
      } catch (error) {
        logger.error(
          {
            error: error.message
          },
          "[HEXGATE] Delete event error"
        );
      }
    }
  );

  /* ==========================================================
     GROUP PARTICIPANTS
  ========================================================== */

  sock.ev.on(
    "group-participants.update",
    async update => {
      try {
        const config =
          getConfig(phone);

        if (
          !config.welcome
        ) {
          return;
        }

        if (
          update.action !== "add"
        ) {
          return;
        }

        const mentions =
          update.participants || [];

        if (
          mentions.length === 0
        ) {
          return;
        }

        const text =
          mentions
            .map(
              participant =>
                `@${participant.split("@")[0]}`
            )
            .join(" ");

        await sendText(
          sock,
          update.id,
          `╭━━〔 ⚡ HEXGATE 〕━━╮\n\n👋 Bienvenue ${text} !\n\nBienvenue dans le groupe.\n\n╰━━━━━━━━━━━━━━━━━━╯`,
          mentions
        );
      } catch (error) {
        logger.error(
          {
            error: error.message
          },
          "[HEXGATE] Welcome error"
        );
      }
    }
  );
}

/* ============================================================
   START SESSION
============================================================ */

async function createSession(
  phoneInput
) {
  const phone =
    normalizePhone(
      phoneInput
    );

  /* ----------------------------------------------------------
     SESSION DÉJÀ ACTIVE
  ---------------------------------------------------------- */

  const existing =
    sessions.get(phone);

  if (existing) {
    return {
      ok: true,
      phone,
      status:
        existing.status,
      code:
        existing.code || null,
      error:
        existing.error || null
    };
  }

  /* ----------------------------------------------------------
     DÉMARRAGE DÉJÀ EN COURS
  ---------------------------------------------------------- */

  if (
    startingSessions.has(phone)
  ) {
    return startingSessions.get(
      phone
    );
  }

  const startPromise =
    startSessionInternal(
      phone
    );

  startingSessions.set(
    phone,
    startPromise
  );

  try {
    return await startPromise;
  } finally {
    startingSessions.delete(
      phone
    );
  }
}

/* ============================================================
   INTERNAL SESSION START
============================================================ */

async function startSessionInternal(
  phone
) {
  const authPath =
    path.join(
      SESSION_DIR,
      phone
    );

  fs.mkdirSync(
    authPath,
    {
      recursive: true
    }
  );

  logger.info(
    `[HEXGATE] Initialisation session ${phone}`
  );

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      authPath
    );

  /* ----------------------------------------------------------
     SOCKET
  ---------------------------------------------------------- */

  const sock =
    makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      /*
       * IMPORTANT POUR LE PAIRING CODE
       */
      browser:
        Browsers.macOS(
          "Google Chrome"
        ),

      /*
       * Ne pas forcer fetchLatestWaWebVersion.
       */

      markOnlineOnConnect:
        false,

      syncFullHistory:
        false,

      connectTimeoutMs:
        60000,

      defaultQueryTimeoutMs:
        60000,

      keepAliveIntervalMs:
        25000
    });

  const entry = {
    phone,
    sock,

    status:
      state.creds.registered
        ? "connecting"
        : "waiting_pairing",

    code: null,

    error: null,

    messageHandlersAttached:
      false,

    reconnecting:
      false
  };

  sessions.set(
    phone,
    entry
  );

  /* ----------------------------------------------------------
     SAVE CREDENTIALS
  ---------------------------------------------------------- */

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /* ----------------------------------------------------------
     MESSAGE HANDLERS
  ---------------------------------------------------------- */

  attachMessageHandlers(
    phone,
    sock
  );

  /* ----------------------------------------------------------
     PAIRING PROMISE
  ---------------------------------------------------------- */

  let pairingResolved =
    false;

  let pairingResolve;

  let pairingReject;

  const pairingPromise =
    new Promise(
      (resolve, reject) => {
        pairingResolve =
          resolve;

        pairingReject =
          reject;
      }
    );

  let pairingRequested =
    state.creds.registered;

  /* ==========================================================
     CONNECTION UPDATE
  ========================================================== */

  sock.ev.on(
    "connection.update",
    async update => {
      try {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        logger.info(
          `[HEXGATE] ${phone} -> connection=${connection || "pending"}${qr ? " qr=true" : ""}`
        );

        /* ----------------------------------------------------
           PAIRING CODE
        ---------------------------------------------------- */

        if (
          !state.creds.registered &&
          !pairingRequested &&
          (
            connection ===
              "connecting" ||
            Boolean(qr)
          )
        ) {
          pairingRequested =
            true;

          try {
            logger.info(
              `[HEXGATE] Demande Pairing Code pour ${phone}`
            );

            const code =
              await sock.requestPairingCode(
                phone
              );

            const formatted =
              formatPairingCode(
                code
              );

            if (!formatted) {
              throw new Error(
                "Baileys a retourné un Pairing Code vide."
              );
            }

            entry.code =
              formatted;

            entry.status =
              "waiting_pairing";

            entry.error =
              null;

            logger.info(
              `[HEXGATE] Pairing Code ${phone}: ${formatted}`
            );

            if (
              !pairingResolved
            ) {
              pairingResolved =
                true;

              pairingResolve(
                formatted
              );
            }
          } catch (error) {
            entry.status =
              "pairing_error";

            entry.error =
              error.message ||
              "Erreur Pairing Code";

            logger.error(
              {
                error:
                  error.message
              },
              `[HEXGATE] Pairing Code error ${phone}`
            );

            if (
              !pairingResolved
            ) {
              pairingResolved =
                true;

              pairingReject(
                error
              );
            }
          }
        }

        /* ----------------------------------------------------
           CONNECTION OPEN
        ---------------------------------------------------- */

        if (
          connection === "open"
        ) {
          entry.status =
            "connected";

          entry.error =
            null;

          entry.code =
            null;

          logger.info(
            `[HEXGATE] 🟢 ${phone} CONNECTÉ`
          );

          /*
           * Résout la promesse si une ancienne
           * session était déjà enregistrée.
           */

          if (
            !pairingResolved
          ) {
            pairingResolved =
              true;

            pairingResolve(
              null
            );
          }

          /*
           * Message de confirmation
           */

          try {
            await sock.sendMessage(
              `${phone}@s.whatsapp.net`,
              {
                text:
`🟢 *HEXGATE CONNECTÉ*

Votre bot WhatsApp est maintenant connecté avec succès.

Tapez *.menu* pour afficher les commandes.

⚡ HEXGATE`
              }
            );
          } catch (error) {
            logger.warn(
              {
                error:
                  error.message
              },
              "[HEXGATE] Message confirmation impossible"
            );
          }
        }

        /* ----------------------------------------------------
           CONNECTION CLOSE
        ---------------------------------------------------- */

        if (
          connection === "close"
        ) {
          const code =
            getDisconnectCode(
              lastDisconnect
            );

          logger.warn(
            `[HEXGATE] ${phone} déconnecté. Code=${code || "unknown"}`
          );

          entry.status =
            "disconnected";

          entry.code =
            null;

          /*
           * Logged out :
           * ne pas recréer automatiquement.
           */

          if (
            code ===
            DisconnectReason.loggedOut
          ) {
            entry.status =
              "logged_out";

            sessions.delete(
              phone
            );

            if (
              !pairingResolved
            ) {
              pairingResolved =
                true;

              pairingReject(
                new Error(
                  "Le compte WhatsApp a été déconnecté."
                )
              );
            }

            return;
          }

          /*
           * Pendant le premier pairing,
           * une fermeture avant connexion doit
           * être signalée au frontend.
           */

          if (
            !state.creds.registered &&
            !pairingResolved
          ) {
            pairingResolved =
              true;

            pairingReject(
              new Error(
                `WhatsApp a fermé la connexion avant le Pairing Code. Code=${code || "inconnu"}`
              )
            );

            sessions.delete(
              phone
            );

            return;
          }

          /*
           * Reconnexion automatique
           */

          if (
            !entry.reconnecting
          ) {
            entry.reconnecting =
              true;

            sessions.delete(
              phone
            );

            setTimeout(
              async () => {
                try {
                  await createSession(
                    phone
                  );
                } catch (error) {
                  logger.error(
                    {
                      error:
                        error.message
                    },
                    `[HEXGATE] Reconnexion échouée ${phone}`
                  );
                }
              },
              code ===
                DisconnectReason.restartRequired
                ? 1000
                : 5000
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            error:
              error.message
          },
          "[HEXGATE] connection.update error"
        );
      }
    }
  );

  /* ==========================================================
     SESSION DÉJÀ ENREGISTRÉE
  ========================================================== */

  if (
    state.creds.registered
  ) {
    return {
      ok: true,

      phone,

      status:
        "connecting",

      code: null,

      error: null
    };
  }

  /* ==========================================================
     ATTENDRE LE VRAI PAIRING CODE
  ========================================================== */

  try {
    const code =
      await Promise.race([
        pairingPromise,

        new Promise(
          (_, reject) => {
            setTimeout(
              () => {
                reject(
                  new Error(
                    "Timeout : aucun Pairing Code n'a été fourni par Baileys après 30 secondes."
                  )
                );
              },
              30000
            );
          }
        )
      ]);

    return {
      ok: true,

      phone,

      status:
        entry.status,

      code:
        code || null,

      error:
        entry.error || null
    };
  } catch (error) {
    entry.status =
      "pairing_error";

    entry.error =
      error.message;

    return {
      ok: false,

      phone,

      status:
        "pairing_error",

      code: null,

      error:
        error.message
    };
  }
}

/* ============================================================
   SESSION STATUS
============================================================ */

async function getSessionStatus(
  phoneInput
) {
  const phone =
    normalizePhone(
      phoneInput
    );

  const entry =
    sessions.get(phone);

  if (entry) {
    return {
      ok: true,

      phone,

      status:
        entry.status,

      code:
        entry.code || null,

      error:
        entry.error || null
    };
  }

  const authPath =
    path.join(
      SESSION_DIR,
      phone
    );

  const credsPath =
    path.join(
      authPath,
      "creds.json"
    );

  return {
    ok: true,

    phone,

    status:
      fs.existsSync(
        credsPath
      )
        ? "saved_session"
        : "not_found",

    code: null,

    error: null
  };
}

/* ============================================================
   LIST SESSIONS
============================================================ */

function listSessions() {
  return Array.from(
    sessions.values()
  ).map(
    entry => ({
      phone:
        entry.phone,

      status:
        entry.status,

      code:
        entry.code || null,

      error:
        entry.error || null
    })
  );
}

/* ============================================================
   LOGOUT
============================================================ */

async function logoutSession(
  phoneInput
) {
  const phone =
    normalizePhone(
      phoneInput
    );

  const entry =
    sessions.get(phone);

  if (entry) {
    try {
      await entry.sock.logout();
    } catch {}
  }

  sessions.delete(
    phone
  );

  /*
   * Suppression de la session locale.
   */

  const authPath =
    path.join(
      SESSION_DIR,
      phone
    );

  try {
    if (
      fs.existsSync(
        authPath
      )
    ) {
      fs.rmSync(
        authPath,
        {
          recursive: true,
          force: true
        }
      );
    }
  } catch (error) {
    logger.warn(
      {
        error:
          error.message
      },
      "[HEXGATE] Impossible de supprimer session"
    );
  }

  return {
    ok: true,
    phone
  };
}

/* ============================================================
   EXPORTS
============================================================ */

module.exports = {
  createSession,
  getSessionStatus,
  listSessions,
  logoutSession
};
