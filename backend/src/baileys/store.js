const fs = require("fs");
const path = require("path");

const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || "./data/media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_ITEMS_PER_SESSION = 500;
const stores = new Map();

function sessionFile(phone) {
  return path.join(MEDIA_DIR, `${phone}.json`);
}

function getStore(phone) {
  if (stores.has(phone)) return stores.get(phone);
  let data = { messages: {} };
  try {
    if (fs.existsSync(sessionFile(phone))) {
      data = JSON.parse(fs.readFileSync(sessionFile(phone), "utf8"));
    }
  } catch {
    data = { messages: {} };
  }
  stores.set(phone, data);
  return data;
}

function saveStore(phone) {
  const data = getStore(phone);
  fs.writeFileSync(sessionFile(phone), JSON.stringify(data));
}

function keyOf(jid, id) {
  return `${jid}:${id}`;
}

function remember(phone, record) {
  const store = getStore(phone);
  store.messages[keyOf(record.remoteJid, record.id)] = {
    id: record.id,
    remoteJid: record.remoteJid,
    participant: record.participant || null,
    fromMe: Boolean(record.fromMe),
    type: record.type,
    text: record.text || null,
    mediaPath: record.mediaPath || null,
    mimetype: record.mimetype || null,
    caption: record.caption || null,
    createdAt: Date.now()
  };

  const entries = Object.entries(store.messages)
    .sort((a,b) => a[1].createdAt - b[1].createdAt);

  while (entries.length > MAX_ITEMS_PER_SESSION) {
    const [oldKey, oldRecord] = entries.shift();
    delete store.messages[oldKey];
    if (oldRecord.mediaPath) {
      try { fs.unlinkSync(oldRecord.mediaPath); } catch {}
    }
  }
  saveStore(phone);
}

function find(phone, jid, id) {
  return getStore(phone).messages[keyOf(jid, id)] || null;
}

module.exports = { MEDIA_DIR, remember, find };
