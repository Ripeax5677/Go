const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'crash_data.json');
const PORT = process.env.CRASH_PORT || 3001;

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmacHex(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest('hex'); }

// simple persistent store
let store = { bank: 1000000, history: [] };
try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (e) { console.warn('Could not read crash data file', e); }
function saveStore(){ fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// verify endpoint
app.get('/crash/verify/:roundId', (req, res) => {
  const r = store.history.find(h => h.id === req.params.roundId);
  if (!r) return res.status(404).json({ error: 'not found' });
  return res.json({ id: r.id, serverSeed: r.serverSeed, seedHash: r.seedHash, crashMultiplier: r.crashMultiplier });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(obj){
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

// Round state
let currentRound = null;
let roundTicker = null;

function computeCrashFromSeed(serverSeed){
  // Based on HMAC mapping to a float, then to multiplier, with house edge 3%
  const h = hmacHex(serverSeed, 'crash');
  const v = parseInt(h.slice(0, 13), 16) / Math.pow(2, 52);
  // map to multiplier, avoid division by zero
  const raw = Math.max(1.0, Math.floor((1 / (1 - v)) * 100) / 100);
  const withEdge = Math.max(1.0, Math.floor(raw * 0.97 * 100) / 100);
  // cap to reasonable max
  return Math.min(withEdge, 10000);
}

function startNewRound(){
  if (roundTicker) { clearInterval(roundTicker); roundTicker = null; }
  const id = crypto.randomBytes(8).toString('hex');
  const serverSeed = crypto.randomBytes(16).toString('hex');
  const seedHash = sha256hex(serverSeed);
  const crashMultiplier = computeCrashFromSeed(serverSeed);
  currentRound = {
    id, serverSeed, seedHash, crashMultiplier,
    bets: {}, // clientId -> {amount, cashed: false, payout:0}
    status: 'betting',
    created: Date.now(),
  };
  broadcast({ type: 'round:start', id: currentRound.id, seedHash: currentRound.seedHash, bettingEnds: Date.now() + 5000, bank: store.bank });

  // allow 5s betting, then run
  setTimeout(() => runRound(currentRound), 5000);
}

function runRound(round){
  round.status = 'running';
  const start = Date.now();
  const crashAt = round.crashMultiplier; // predetermined
  let crashed = false;
  broadcast({ type: 'round:run', id: round.id });

  roundTicker = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000; // seconds
    // exponential-like growth for visuals
    const cur = Math.max(1, Math.pow(1.07, elapsed));
    const curRounded = Math.floor(cur * 100) / 100;
    if (!crashed && curRounded >= crashAt) {
      crashed = true;
      round.status = 'crashed';
      broadcast({ type: 'round:crash', id: round.id, crashMultiplier: crashAt });
      finalizeRound(round);
      clearInterval(roundTicker);
      roundTicker = null;
      // store history
      store.history.unshift({ id: round.id, crashMultiplier: round.crashMultiplier, serverSeed: round.serverSeed, seedHash: round.seedHash, bets: round.bets, timestamp: Date.now() });
      if (store.history.length > 50) store.history.pop();
      saveStore();
      // start next after short delay
      setTimeout(startNewRound, 4000);
      return;
    }
    broadcast({ type: 'round:tick', id: round.id, multiplier: curRounded });
  }, 100);
}

function finalizeRound(round){
  // pay all cashed players (already handled on cashout)
  // for any players who didn't cash out, no payout
  // update bank persisted above when paying
}

// WebSocket message handling
wss.on('connection', (ws) => {
  // give initial state
  ws.send(JSON.stringify({ type: 'info', bank: store.bank, history: store.history.slice(0,10) }));

  ws.on('message', (msg) => {
    let data = null;
    try { data = JSON.parse(msg); } catch (e) { return; }
    if (!data || !data.type) return;
    if (data.type === 'placeBet'){
      const { clientId, amount, roundId } = data;
      if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'betting'){
        return ws.send(JSON.stringify({ type: 'bet:rejected', reason: 'no active betting phase' }));
      }
      const a = Number(amount) || 0; if (a <= 0) return;
      currentRound.bets[clientId] = { amount: a, cashed: false, payout: 0 };
      ws.send(JSON.stringify({ type: 'bet:accepted', clientId, amount: a }));
      broadcast({ type: 'bet:update', roundId: currentRound.id, bets: Object.values(currentRound.bets).map(b=>b.amount).reduce((s,n)=>s+n,0) });
    }
    if (data.type === 'cashout'){
      const { clientId, roundId } = data;
      if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'running') return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'not running' }));
      const betRec = currentRound.bets[clientId];
      if (!betRec || betRec.cashed) return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'no bet or already cashed' }));
      // compute current multiplier (we approximate from last broadcast time by using server time)
      // For simplicity, use the last 'tick' multiplier approximated by time since round start
      // Recompute elapsed as we do in runRound
      const elapsed = (Date.now() - (currentRound.created || Date.now())) / 1000;
      const cur = Math.max(1, Math.pow(1.07, elapsed));
      const curRounded = Math.floor(cur * 100) / 100;
      // if already crashed
      if (curRounded >= currentRound.crashMultiplier) return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'too late - crashed' }));
      const payout = Math.floor(betRec.amount * curRounded * 100) / 100;
      // ensure bank can cover
      if (payout > store.bank) {
        // cap payout to bank
        const capped = Math.floor(store.bank * 100) / 100;
        betRec.cashed = true; betRec.payout = capped;
        store.bank = 0;
        saveStore();
        ws.send(JSON.stringify({ type: 'cashout:ok', clientId, payout: capped }));
        broadcast({ type: 'bank:update', bank: store.bank });
        return;
      }
      // pay out
      betRec.cashed = true; betRec.payout = payout;
      store.bank -= payout;
      saveStore();
      ws.send(JSON.stringify({ type: 'cashout:ok', clientId, payout }));
      broadcast({ type: 'bank:update', bank: store.bank });
    }
  });
});

server.listen(PORT, () => console.log(`Crash server listening on http://localhost:${PORT}`));

// Start first round
startNewRound();
