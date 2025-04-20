const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode");
const {
  delay,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  default: makeWASocket,
} = require("@whiskeysockets/baileys");
const { Storage } = require("megajs");

const router = express.Router();

const randomMegaId = (length = 6, numberLength = 4) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  const number = Math.floor(Math.random() * Math.pow(10, numberLength));
  return `${result}${number}`;
};

const uploadCredsToMega = async (credsPath) => {
  const storage = await new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD,
  }).ready;

  const fileSize = fs.statSync(credsPath).size;
  const uploadResult = await storage.upload({
    name: `${randomMegaId()}.json`,
    size: fileSize
  }, fs.createReadStream(credsPath)).complete;

  const fileNode = storage.files[uploadResult.nodeId];
  const megaUrl = await fileNode.link();
  return megaUrl;
};

const removeFile = (filePath) => {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
};

router.get("/", async (req, res) => {
  const id = Math.random().toString(36).slice(2, 10);
  const sessionPath = `./temp/${id}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  try {
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
      },
      logger: pino({ level: "fatal" }),
      browser: Browsers.macOS("Safari"),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, qr }) => {
      if (qr) {
        const qrImage = await qrcode.toDataURL(qr);
        res.send(`<img src="${qrImage}" style="width: 300px;"><br><p>Scan to link WhatsApp</p>`);
      }

      if (connection === "open") {
        await delay(3000);

        const credsFile = `${sessionPath}/creds.json`;
        if (!fs.existsSync(credsFile)) return;

        const megaUrl = await uploadCredsToMega(credsFile);
        const sessionId = megaUrl.replace("https://mega.nz/file/", "");

        const userJid = sock.user.id;
        await sock.sendMessage(userJid, {
          text: `✅ *Session ID Generated*\n\nYour Session ID:\n${sessionId}`
        });

        await delay(1000);
        await sock.ws.close();
        removeFile(sessionPath);
      }
    });

  } catch (err) {
    console.error("Session generation error:", err);
    removeFile(sessionPath);
    res.status(500).send("Failed to create session");
  }
});

module.exports = router;
