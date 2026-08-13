require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { createWhatsAppSession, getSessionStatus } = require("./baileys/sessionManager");

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || "";
const FRONTEND = path.join(__dirname, "../../frontend");

app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(express.static(FRONTEND));

function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "HEXGATE", time: new Date().toISOString() });
});

app.post("/api/pairing", auth, async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/[^\d]/g, "");
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ error: "Numéro WhatsApp invalide. Utilisez le format international sans +." });
    }

    const result = await createWhatsAppSession(phone);
    res.json({
      ok: true,
      phone,
      status: result.status,
      code: result.code || null,
      message: result.code
        ? "Code généré. Saisissez-le dans WhatsApp > Appareils connectés > Connecter un appareil."
        : "Session démarrée. Attendez le code."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Impossible de générer le code de pairing." });
  }
});

app.get("/api/session/:phone", auth, async (req, res) => {
  const phone = String(req.params.phone).replace(/[^\d]/g, "");
  res.json(await getSessionStatus(phone));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(FRONTEND, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HEXGATE running on port ${PORT}`);
});
