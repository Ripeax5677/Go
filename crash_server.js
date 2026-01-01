const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3001;
const HOUSE_EDGE = 0.97; // 3%
const TICK_RATE = 100; // ms
const GROWTH_RATE = 0.00006;

/* =========================
   STATE
========================= */
let currentRound = null;
let history = [];
let nonce = 0;

/* =========================
   FAIR CRASH FUNCTION
========================= */
function computeCrash(serverSeed, clientSeed, nonce) {
  const hmac = crypto
    .createHmac("sha256", serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest();

  const h =
    (hmac.readUIntBE(0, 6) & 0x1fffffffffffff) >>> 0;

  const e = Math.pow(2, 52);
  let crash = Math.floor((100 * e - h) / (e - h)) / 100;

  crash = Math.max(1.0, Math.floor(crash * HOUSE_EDGE * 100) / 100);
  return crash;
}

/* =========================
   ROUND CONTROL
========================= */
function startNewRound() {
  const serverSeed = crypto.randomBytes(32).toString("hex");
  const clientSeed = crypto.randomBytes(8).toString("hex");
  const seedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");

  const crashPoint = computeCrash(serverSeed, clientSeed, nonce);

  currentRound = {
    id: Date.now(),
    serverSeed,
    clientSeed,
    seedHash,
    nonce,
    crashPoint,
    startedAt: Date.now(),
    active: true
  };

  nonce++;

  io.emit("round_start", {
    id: currentRound.id,
    seedHash: currentRound.seedHash
  });

  runRound();
}

function runRound() {
  let multiplier = 1.0;
  const start = Date.now();

  const interval = setInterval(() => {
    const elapsed = Date.now() - start;
    multiplier = Math.exp(GROWTH_RATE * elapsed);

    if (multiplier >= currentRound.crashPoint) {
      multiplier = currentRound.crashPoint;
      clearInterval(interval);
      endRound(multiplier);
      return;
    }

    io.emit("tick", {
      multiplier: Number(multiplier.toFixed(2))
    });
  }, TICK_RATE);
}

function endRound(finalMultiplier) {
  currentRound.active = false;

  const finishedRound = {
    id: currentRound.id,
    crashMultiplier: Number(finalMultiplier.toFixed(2)),
    serverSeed: currentRound.serverSeed,
    clientSeed: currentRound.clientSeed,
    nonce: currentRound.nonce,
    seedHash: currentRound.seedHash
  };

  history.unshift(finishedRound);
  history = history.slice(0, 50);

  io.emit("round_end", finishedRound);

  setTimeout(startNewRound, 3000);
}

/* =========================
   API
========================= */
app.get("/api/history", (req, res) => {
  res.json(history);
});

app.get("/api/verify/:id", (req, res) => {
  const round = history.find(r => r.id == req.params.id);
  if (!round) return res.status(404).json({ error: "not found" });

  res.json(round);
});

/* =========================
   START
========================= */
server.listen(PORT, () => {
  console.log("Crash server running on port", PORT);
  startNewRound();
});
