const fs = require("fs");
const path = require("path");
const P = require("pino");
const { Boom } = require("@hapi/boom");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers
} = require("@whiskeysockets/baileys");

const {
  remember,
  find,
  MEDIA_DIR
} = require("./store");

const BASE = path.resolve(
  process.env.SESSION_DIR || "./data/sessions"
);

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

/* =========================================================
   PHONE
========================================================= */

function normalizePhone(input) {
  const phone = String(input || "").replace(/\D/g, "");

  if (!/^\d{8,15}$/.test(phone)) {
    throw new Error(
      "Numéro invalide. Utilisez le format international sans +. Exemple : 2438XXXXXXXX"
    );
  }

  return phone;
}

/* =========================================================
   CONFIG
========================================================= */

function getConfig(phone) {
  if (!configs.has(phone)) {
    configs.set(phone, {
      ...DEFAULT_CONFIG
    });
  }

  return configs.get(phone);
}

/* =========================================================
   MESSAGE HELPERS
========================================================= */

function unwrapMessage(message) {
  let m = message;

  while (m?.ephemeralMessage?.message) {
    m = m.ephemeralMessage.message;
  }

  while (m?.viewOnceMessage?.message) {
    m = m.viewOnceMessage.message;
  }

  while (m?.viewOnceMessageV2?.message) {
    m = m.viewOnceMessageV2.message;
  }

  while (m?.documentWithCaptionMessage?.message) {
    m = m.documentWithCaptionMessage.message;
  }

  return m || {};
}

function extractText(message) {
  const m = unwrapMessage(message);

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function isLink(text) {
  return /(
    https?:\/\/|
    www\.|
    wa\.me\/|
    chat\.whatsapp\.com\/|
    t\.me\/|
    telegram\.me\/
  )/ix.test(text);
}

function isAdmin(metadata, jid) {
  const participant = metadata?.participants?.find(
    p => p.id === jid
  );

  return ["admin", "superadmin"].includes(
    participant?.admin
  );
}

/* =========================================================
   CODE FORMAT
========================================================= */

function formatCode(code) {
  if (!code) return null;

  const clean = String(code).replace(/[^A-Z0-9]/gi, "");

  return clean.match(/.{1,4}/g)?.join("-") || clean;
}

/* =========================================================
   SAVE RECEIVED MESSAGE
========================================================= */

async function saveReceivedMessage(phone, msg) {
  if (
    !msg?.message ||
    !msg?.key?.id ||
    !msg?.key?.remoteJid
  ) {
    return;
  }

  const m = unwrapMessage(msg.message);

  const text = extractText(msg.message);

  let type = "text";
  let mediaPath = null;
  let mimetype = null;
  let caption = null;

  try {
    if (m.imageMessage) {
      type = "image";
      mimetype =
        m.imageMessage.mimetype ||
        "image/jpeg";

      caption =
        m.imageMessage.caption ||
        "";
    }

    else if (m.videoMessage) {
      type = "video";
      mimetype =
        m.videoMessage.mimetype ||
        "video/mp4";

      caption =
        m.videoMessage.caption ||
        "";
    }

    else if (m.audioMessage) {
      type = "audio";
      mimetype =
        m.audioMessage.mimetype ||
        "audio/ogg";
    }

    else if (m.documentMessage) {
      type = "document";
      mimetype =
        m.documentMessage.mimetype ||
        "application/octet-stream";
    }

    if (
      ["image", "video", "audio", "document"]
        .includes(type)
    ) {
      const buffer =
        await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: P({
              level: "silent"
            }),
            reuploadRequest: async () => null
          }
        );

      const extension =
        type === "image"
          ? "jpg"
          : type === "video"
            ? "mp4"
            : type === "audio"
              ? "ogg"
              : "bin";

      mediaPath = path.join(
        MEDIA_DIR,
        `${phone}-${Date.now()}-${msg.key.id}.${extension}`
      );

      fs.writeFileSync(
        mediaPath,
        buffer
      );
    }
  }

  catch (error) {
    console.warn(
      "[HEXGATE] Media archive error:",
      error.message
    );
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

/* =========================================================
   RESTORE DELETED MESSAGE
========================================================= */

async function restoreDeleted(
  phone,
  sock,
  revokedMessage
) {
  const jid =
    revokedMessage?.key?.remoteJid;

  const id =
    revokedMessage?.key?.id;

  if (!jid || !id) return;

  const saved = find(
    phone,
    jid,
    id
  );

  if (!saved) {
    console.log(
      "[HEXGATE] Message supprimé introuvable:",
      id
    );

    return;
  }

  try {
    let content;

    if (
      saved.type === "image" &&
      saved.mediaPath &&
      fs.existsSync(saved.mediaPath)
    ) {
      content = {
        image: fs.readFileSync(
          saved.mediaPath
        ),
        caption:
          saved.caption || ""
      };
    }

    else if (
      saved.type === "video" &&
      saved.mediaPath &&
      fs.existsSync(saved.mediaPath)
    ) {
      content = {
        video: fs.readFileSync(
          saved.mediaPath
        ),
        caption:
          saved.caption || ""
      };
    }

    else if (
      saved.type === "audio" &&
      saved.mediaPath &&
      fs.existsSync(saved.mediaPath)
    ) {
      content = {
        audio: fs.readFileSync(
          saved.mediaPath
        ),
        mimetype:
          saved.mimetype ||
          "audio/ogg",
        ptt: false
      };
    }

    else if (
      saved.type === "document" &&
      saved.mediaPath &&
      fs.existsSync(saved.mediaPath)
    ) {
      content = {
        document: fs.readFileSync(
          saved.mediaPath
        ),
        mimetype:
          saved.mimetype ||
          "application/octet-stream",
        fileName:
          "HEXGATE-restored-file"
      };
    }

    else {
      content = {
        text:
          saved.text ||
          "[Message supprimé]"
      };
    }

    await sock.sendMessage(
      jid,
      {
        ...content,
        contextInfo: {
          externalAdReply: {
            title:
              "HEXGATE • Anti-Delete",
            body:
              "Contenu restauré après suppression",
            mediaType: 1
          }
        }
      }
    );

    console.log(
      `[HEXGATE] Contenu restauré: ${id}`
    );
  }

  catch (error) {
    console.error(
      "[HEXGATE] Restore error:",
      error.message
    );
  }
}

/* =========================================================
   CREATE SESSION
========================================================= */

async function createSession(phoneInput) {
  const phone =
    normalizePhone(phoneInput);

  /* -----------------------------------------
     Session déjà active
  ----------------------------------------- */

  if (sessions.has(phone)) {
    const existing =
      sessions.get(phone);

    return {
      phone,
      status:
        existing.status,
      code:
        existing.code
          ? formatCode(existing.code)
          : null,
      error:
        existing.error || null
    };
  }

  const authPath =
    path.join(BASE, phone);

  fs.mkdirSync(
    authPath,
    { recursive: true }
  );

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      authPath
    );

  /*
   * IMPORTANT :
   * Pour le pairing code, Baileys demande
   * un navigateur logique/valide.
   */
  const sock =
    makeWASocket({
      auth: state,

      logger: P({
        level:
          process.env.LOG_LEVEL ||
          "info"
      }),

      printQRInTerminal: false,

      browser:
        Browsers.macOS(
          "Google Chrome"
        ),

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs:
        60000,

      defaultQueryTimeoutMs:
        60000,

      keepAliveIntervalMs:
        25000,

      generateHighQualityLinkPreview:
        false
    });

  const entry = {
    sock,
    phone,
    status: "connecting",
    code: null,
    error: null
  };

  sessions.set(
    phone,
    entry
  );

  /*
   * Sauvegarde des credentials
   */
  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /* =====================================================
     PROMESSE DU PAIRING CODE

     C'est LA correction importante.

     createSession() ne retourne plus immédiatement
     avec code:null.

     Il attend réellement que Baileys fournisse
     requestPairingCode().
  ===================================================== */

  let pairingPromiseResolve;
  let pairingPromiseReject;

  const pairingPromise =
    new Promise(
      (resolve, reject) => {
        pairingPromiseResolve =
          resolve;

        pairingPromiseReject =
          reject;
      }
    );

  let pairingRequested = false;

  /* =====================================================
     CONNECTION UPDATE
  ===================================================== */

  sock.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      console.log(
        `[HEXGATE] ${phone} connection.update:`,
        connection || "pending",
        qr ? "QR/EVENT" : ""
      );

      /*
       * Pairing Code
       *
       * Baileys recommande de demander le code
       * après le début de la connexion.
       */
      if (
        !state.creds.registered &&
        !pairingRequested &&
        (
          connection === "connecting" ||
          !!qr
        )
      ) {
        pairingRequested = true;

        try {
          const code =
            await sock.requestPairingCode(
              phone
            );

          if (!code) {
            throw new Error(
              "Baileys n'a retourné aucun Pairing Code."
            );
          }

          entry.code = code;
          entry.status =
            "waiting_pairing";

          console.log(
            `[HEXGATE] Pairing code ${phone}: ${formatCode(code)}`
          );

          pairingPromiseResolve(
            formatCode(code)
          );
        }

        catch (error) {
          entry.status =
            "pairing_error";

          entry.error =
            error?.message ||
            "Erreur Pairing Code";

          pairingPromiseReject(
            error
          );

          console.error(
            "[HEXGATE] Pairing Code error:",
            error
          );
        }
      }

      /* =================================================
         CONNECTÉ
      ================================================= */

      if (
        connection === "open"
      ) {
        entry.status =
          "connected";

        entry.code = null;
        entry.error = null;

        console.log(
          `[HEXGATE] ${phone} CONNECTED`
        );

        /*
         * Si le frontend attend encore le code
         * mais que la session est déjà ouverte,
         * on évite de bloquer la promesse.
         */
        if (!pairingRequested) {
          pairingPromiseResolve(
            null
          );
        }

        /*
         * Message automatique au numéro connecté.
         */
        try {
          await sock.sendMessage(
            `${phone}@s.whatsapp.net`,
            {
              text:
                "🟢 *HEXGATE CONNECTÉ*\n\n" +
                "Votre bot WhatsApp est maintenant connecté avec succès.\n\n" +
                "Tapez *.menu* pour afficher les commandes."
            }
          );
        }

        catch (error) {
          console.warn(
            "[HEXGATE] Confirmation message error:",
            error.message
          );
        }
      }

      /* =================================================
         DÉCONNEXION
      ================================================= */

      if (
        connection === "close"
      ) {
        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output
            ?.statusCode;

        console.log(
          `[HEXGATE] ${phone} closed. Status:`,
          statusCode
        );

        entry.status =
          "disconnected";

        entry.code = null;

        /*
         * Si le pairing est encore attendu,
         * rejeter la promesse.
         */
        if (
          !state.creds.registered &&
          entry.status !==
            "connected"
        ) {
          if (
            !entry.error
          ) {
            entry.error =
              `Connexion fermée (${statusCode || "inconnue"}).`;
          }

          try {
            pairingPromiseReject(
              new Error(
                entry.error
              )
            );
          }

          catch {}
        }

        /*
         * Compte déconnecté définitivement.
         */
        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          sessions.delete(
            phone
          );

          console.log(
            `[HEXGATE] ${phone} logged out`
          );

          return;
        }

        /*
         * Reconnexion automatique.
         */
        sessions.delete(
          phone
        );

        setTimeout(
          () => {
            createSession(
              phone
            ).catch(
              error =>
                console.error(
                  "[HEXGATE] Reconnect error:",
                  error.message
                )
            );
          },
          5000
        );
      }
    }
  );

  /* =====================================================
     ATTENDRE LE VRAI CODE
  ===================================================== */

  if (
    !state.creds.registered
  ) {
    try {
      const code =
        await Promise.race([
          pairingPromise,

          new Promise(
            (_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "Timeout : Baileys n'a pas fourni de Pairing Code."
                    )
                  ),
                30000
              )
          )
        ]);

      return {
        phone,
        status:
          entry.status,
        code,
        error:
          entry.error
      };
    }

    catch (error) {
      return {
        phone,
        status:
          entry.status ||
          "pairing_error",
        code: null,
        error:
          error.message
      };
    }
  }

  /*
   * Session déjà enregistrée.
   */
  return {
    phone,
    status:
      entry.status,
    code: null,
    error: null
  };
}

/* =========================================================
   MESSAGE EVENTS
========================================================= */

function attachMessageHandlers(
  phone,
  sock
) {
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
        const msg of messages
      ) {
        try {
          if (
            !msg.message ||
            !msg.key?.remoteJid
          ) {
            continue;
          }

          const cfg =
            getConfig(phone);

          /*
           * Anti-delete :
           * archiver les messages reçus.
           */
          if (
            !msg.key.fromMe &&
            cfg.antiDelete
          ) {
            await saveReceivedMessage(
              phone,
              msg
            );
          }

          /*
           * Commandes envoyées par le bot.
           */
          if (
            msg.key.fromMe
          ) {
            const text =
              extractText(
                msg.message
              );

            if (
              text.startsWith(".")
            ) {
              await handleCommand(
                phone,
                sock,
                msg,
                text,
                cfg
              );
            }

            continue;
          }

          const jid =
            msg.key.remoteJid;

          /*
           * Fake recording
           */
          if (
            cfg.fakeRecording
          ) {
            try {
              await sock.sendPresenceUpdate(
                "recording",
                jid
              );

              setTimeout(
                () =>
                  sock.sendPresenceUpdate(
                    "paused",
                    jid
                  ).catch(() => {}),
                2500
              );
            }

            catch {}
          }

          /*
           * Les règles de groupe commencent ici.
           */
          if (
            !jid.endsWith(
              "@g.us"
            )
          ) {
            continue;
          }

          const text =
            extractText(
              msg.message
            );

          const metadata =
            await sock
              .groupMetadata(
                jid
              )
              .catch(() => null);

          if (!metadata) {
            continue;
          }

          const sender =
            msg.key.participant ||
            msg.key.remoteJid;

          const admin =
            isAdmin(
              metadata,
              sender
            );

          /*
           * Anti-link
           */
          if (
            cfg.antiLink &&
            isLink(text) &&
            !admin
          ) {
            await sock.sendMessage(
              jid,
              {
                delete:
                  msg.key
              }
            );

            await sock.sendMessage(
              jid,
              {
                text:
                  `🚫 @${sender.split("@")[0]} lien supprimé.`,
                mentions: [
                  sender
                ]
              }
            );

            continue;
          }

          /*
           * Anti-spam simple.
           */
          if (
            cfg.antiSpam &&
            text.length > 1500 &&
            !admin
          ) {
            await sock.sendMessage(
              jid,
              {
                delete:
                  msg.key
              }
            );

            continue;
          }
        }

        catch (error) {
          console.error(
            "[HEXGATE] Message handler:",
            error.message
          );
        }
      }
    }
  );

  /*
   * Suppression de message.
   */
  sock.ev.on(
    "messages.update",
    async updates => {
      const cfg =
        getConfig(phone);

      if (
        !cfg.antiDelete
      ) {
        return;
      }

      for (
        const update of updates
      ) {
        try {
          const protocol =
            update.update
              ?.message
              ?.protocolMessage;

          /*
           * 0 = REVOKE dans les versions
           * courantes utilisées ici.
           */
          if (
            protocol?.type === 0
          ) {
            await restoreDeleted(
              phone,
              sock,
              {
                key: {
                  remoteJid:
                    update.key.remoteJid,

                  id:
                    protocol.key?.id ||
                    update.key.id
                }
              }
            );
          }
        }

        catch (error) {
          console.error(
            "[HEXGATE] Anti-delete error:",
            error.message
          );
        }
      }
    }
  );
}

/* =========================================================
   COMMANDS
========================================================= */

async function handleCommand(
  phone,
  sock,
  msg,
  raw,
  cfg
) {
  const jid =
    msg.key.remoteJid;

  const args =
    raw
      .trim()
      .split(/\s+/);

  const command =
    args[0].toLowerCase();

  const value =
    args[1]?.toLowerCase();

  const group =
    jid.endsWith("@g.us")
      ? await sock
          .groupMetadata(jid)
          .catch(() => null)
      : null;

  const sender =
    msg.key.participant ||
    msg.key.remoteJid;

  const admin =
    !group ||
    isAdmin(
      group,
      sender
    );

  const requireAdmin =
    async () => {
      if (!admin) {
        await sock.sendMessage(
          jid,
          {
            text:
              "⛔ Commande réservée aux administrateurs."
          }
        );

        return false;
      }

      return true;
    };

  switch (command) {
    case ".menu":

      await sock.sendMessage(
        jid,
        {
          text:
`╭━━━〔 ⚡ HEXGATE ⚡ 〕━━━╮
┃     CYBERPUNK BOT
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

⚡ HEXGATE ONLINE`
        }
      );

      break;

    case ".fakerecording":

      if (
        !(await requireAdmin())
      ) return;

      if (
        !["on", "off"]
          .includes(value)
      ) {
        await sock.sendMessage(
          jid,
          {
            text:
              `Usage : .fakerecording on/off\nÉtat : ${cfg.fakeRecording ? "ON" : "OFF"}`
          }
        );

        return;
      }

      cfg.fakeRecording =
        value === "on";

      await sock.sendMessage(
        jid,
        {
          text:
            `🎙️ Fake Recording : ${cfg.fakeRecording ? "ON" : "OFF"}`
        }
      );

      break;

    case ".antidelete":

      if (
        !(await requireAdmin())
      ) return;

      if (
        !["on", "off"]
          .includes(value)
      ) {
        await sock.sendMessage(
          jid,
          {
            text:
              `Usage : .antidelete on/off\nÉtat : ${cfg.antiDelete ? "ON" : "OFF"}`
          }
        );

        return;
      }

      cfg.antiDelete =
        value === "on";

      await sock.sendMessage(
        jid,
        {
          text:
            `🧬 Anti-Delete : ${cfg.antiDelete ? "ON" : "OFF"}`
        }
      );

      break;

    case ".antilink":

      if (
        !(await requireAdmin())
      ) return;

      if (
        !["on", "off"]
          .includes(value)
      ) {
        await sock.sendMessage(
          jid,
          {
            text:
              `Usage : .antilink on/off\nÉtat : ${cfg.antiLink ? "ON" : "OFF"}`
          }
        );

        return;
      }

      cfg.antiLink =
        value === "on";

      await sock.sendMessage(
        jid,
        {
          text:
            `🔗 Anti-Link : ${cfg.antiLink ? "ON" : "OFF"}`
        }
      );

      break;

    case ".antispam":

      if (
        !(await requireAdmin())
      ) return;

      if (
        !["on", "off"]
          .includes(value)
      ) {
        await sock.sendMessage(
          jid,
          {
            text:
              `Usage : .antispam on/off\nÉtat : ${cfg.antiSpam ? "ON" : "OFF"}`
          }
        );

        return;
      }

      cfg.antiSpam =
        value === "on";

      await sock.sendMessage(
        jid,
        {
          text:
            `🛡️ Anti-Spam : ${cfg.antiSpam ? "ON" : "OFF"}`
        }
      );

      break;

    case ".welcome":

      if (
        !(await requireAdmin())
      ) return;

      if (
        !["on", "off"]
          .includes(value)
      ) {
        await sock.sendMessage(
          jid,
          {
            text:
              `Usage : .welcome on/off\nÉtat : ${cfg.welcome ? "ON" : "OFF"}`
          }
        );

        return;
      }

      cfg.welcome =
        value === "on";

      await sock.sendMessage(
        jid,
        {
          text:
            `👋 Welcome : ${cfg.welcome ? "ON" : "OFF"}`
        }
      );

      break;

    case ".tagall":

      if (
        !(await requireAdmin())
      ) return;

      if (!group) {
        return;
      }

      const mentions =
        group.participants
          .map(
            p => p.id
          );

      await sock.sendMessage(
        jid,
        {
          text:
            "⚡ HEXGATE TAGALL\n\n" +
            mentions
              .map(
                x =>
                  `@${x.split("@")[0]}`
              )
              .join(" "),

          mentions
        }
      );

      break;

    case ".groupinfo":

      if (!group) {
        await sock.sendMessage(
          jid,
          {
            text:
              "Cette commande doit être utilisée dans un groupe."
          }
        );

        return;
      }

      await sock.sendMessage(
        jid,
        {
          text:
`╭─〔 GROUP INFO 〕─╮
Nom : ${group.subject}
Membres : ${group.participants.length}
HEXGATE : ${phone}`
        }
      );

      break;

    case ".admins":

      if (!group) {
        return;
      }

      const admins =
        group.participants
          .filter(
            p =>
              ["admin", "superadmin"]
                .includes(p.admin)
          );

      await sock.sendMessage(
        jid,
        {
          text:
            "👑 ADMINS\n\n" +
            admins
              .map(
                x =>
                  `@${x.id.split("@")[0]}`
              )
              .join("\n"),

          mentions:
            admins.map(
              x => x.id
            )
        }
      );

      break;

    case ".ping":

      await sock.sendMessage(
        jid,
        {
          text:
            `⚡ PONG\nHEXGATE ONLINE\nUptime: ${Math.floor(process.uptime())}s`
        }
      );

      break;

    case ".botstatus":

      await sock.sendMessage(
        jid,
        {
          text:
`╭─〔 HEXGATE STATUS 〕─╮

WhatsApp : CONNECTED
Anti-Link : ${cfg.antiLink ? "ON" : "OFF"}
Anti-Spam : ${cfg.antiSpam ? "ON" : "OFF"}
Anti-Delete : ${cfg.antiDelete ? "ON" : "OFF"}
Fake Recording : ${cfg.fakeRecording ? "ON" : "OFF"}
Welcome : ${cfg.welcome ? "ON" : "OFF"}

Uptime : ${Math.floor(process.uptime())}s`
        }
      );

      break;
  }
}

/* =========================================================
   STATUS
========================================================= */

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
        entry.code
          ? formatCode(entry.code)
          : null,
      error:
        entry.error ||
        null
    };
  }

  const authPath =
    path.join(
      BASE,
      phone
    );

  return {
    ok: true,
    phone,
    status:
      fs.existsSync(
        path.join(
          authPath,
          "creds.json"
        )
      )
        ? "saved_session"
        : "not_found",
    code: null,
    error: null
  };
}

/* =========================================================
   LIST SESSIONS
========================================================= */

function listSessions() {
  return [
    ...sessions.values()
  ].map(
    entry => ({
      phone:
        entry.phone,

      status:
        entry.status,

      code:
        entry.code
          ? formatCode(entry.code)
          : null,

      error:
        entry.error ||
        null
    })
  );
}

/* =========================================================
   LOGOUT
========================================================= */

async function logoutSession(
  phoneInput
) {
  const phone =
    normalizePhone(
      phoneInput
    );

  const entry =
    sessions.get(phone);

  if (!entry) {
    return;
  }

  try {
    await entry.sock.logout();
  }

  catch {}

  sessions.delete(
    phone
  );
}

/* =========================================================
   STARTUP MESSAGE HANDLERS
========================================================= */

function attachHandlersToExistingSessions() {
  for (
    const entry of sessions.values()
  ) {
    attachMessageHandlers(
      entry.phone,
      entry.sock
    );
  }
}

/*
 * Les handlers doivent être attachés après création.
 * On surcharge createSession ici pour garantir cela.
 */
const originalCreateSession =
  createSession;

async function createSessionWithHandlers(
  phone
) {
  const result =
    await originalCreateSession(
      phone
    );

  const normalized =
    normalizePhone(
      phone
    );

  const entry =
    sessions.get(
      normalized
    );

  if (
    entry &&
    !entry.handlersAttached
  ) {
    entry.handlersAttached = true;

    attachMessageHandlers(
      normalized,
      entry.sock
    );
  }

  return result;
}

module.exports = {
  createSession:
    createSessionWithHandlers,

  getSessionStatus,

  listSessions,

  logoutSession
};
