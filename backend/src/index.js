require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const {
  createSession,
  getSessionStatus,
  listSessions,
  logoutSession
} = require("./baileys/sessionManager");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "";
const FRONTEND = path.resolve(__dirname, "../../frontend");

app.disable("x-powered-by");
app.use(cors({ origin: true }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(FRONTEND));

const dataDir = path.resolve(process.env.SESSION_DIR || "./data/sessions");
fs.mkdirSync(dataDir, { recursive: true });

function auth(req, res, next) {
  if (!API_KEY) return next();
  const supplied = req.headers["x-api-key"];
  if (!supplied || supplied !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "HEXGATE",
    version: "2.0.0",
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

app.post("/api/pairing", auth, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "");
    if (!phone) return res.status(400).json({ ok: false, error: "Numéro requis." });

    const result = await createSession(phone);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("[API] pairing:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "Impossible de démarrer la session."
    });
  }
});

app.get("/api/session/:phone", auth, async (req, res) => {
  try {
    res.json(await getSessionStatus(req.params.phone));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/sessions", auth, (_req, res) => {
  res.json({ ok: true, sessions: listSessions() });
});

app.delete("/api/session/:phone", auth, async (req, res) => {
  try {
    await logoutSession(req.params.phone);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(FRONTEND, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HEXGATE] Server listening on ${PORT}`);
});
