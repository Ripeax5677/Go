const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const WebSocket = require('ws');

const CRASH_DATA_FILE = path.join(__dirname, 'crash_data.json');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

// ================== CONFIG ==================
let config = {
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin',
  adminPassHash: null,
};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  const j = JSON.parse(raw);
  config = Object.assign(config, j);
} catch (e) {}

config.discordClientId = process.env.DISCORD_CLIENT_ID || config.discordClientId || null;
config.discordClientSecret = process.env.DISCORD_CLIENT_SECRET || config.discordClientSecret || null;
config.discordRedirect = process.env.DISCORD_REDIRECT || config.discordRedirect || `http://localhost:${PORT}/auth/discord/callback`;

let adminPassHash = null;
if (config.adminPassHash) {
  adminPassHash = String(config.adminPassHash);
} else if (config.adminPass) {
  const salt = bcrypt.genSaltSync(10);
  adminPassHash = bcrypt.hashSync(String(config.adminPass), salt);
}

// In-memory sessions
const sessions = new Map();
function createSession(payload = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + 1000 * 60 * 60 * 24;
  const obj = Object.assign({ exp }, payload);
  sessions.set(token, obj);
  return token;
}
function validateSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return s;
}

// ================== COOKIE HELPERS ==================
function getCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const parts = raw.split(';').map(s => s.trim());
  const m = parts.find(p => p.startsWith(name + '='));
  if (!m) return null;
  return decodeURIComponent(m.split('=')[1]);
}
function getUserToken(req) {
  return getCookie(req, 'userToken') || req.get('x-user-token') || req.query.token || null;
}

// Redirect /index.html if no token
app.get('/index.html', (req, res, next) => {
  const token = req.query.token || req.get('x-user-token') || getCookie(req, 'userToken');
  if (!token && !req.session) return res.redirect('/login.html');
  next();
});

app.use(express.static(path.join(__dirname)));

// ================== SQLITE ==================
const DB_FILE = path.join(__dirname, 'flips.db');
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS flips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome TEXT,
    user TEXT,
    ts INTEGER,
    serverSeed TEXT,
    clientSeed TEXT,
    seedId TEXT,
    bet INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE,
    username TEXT,
    balance INTEGER DEFAULT 0,
    avatar_url TEXT,
    banned INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS mines_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    discord_id TEXT,
    username TEXT,
    bet INTEGER,
    bomb_count INTEGER,
    server_seed TEXT,
    client_seed TEXT,
    seed_hash TEXT,
    board TEXT,
    moves TEXT,
    outcome TEXT,
    multiplier REAL,
    payout INTEGER,
    ts INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

// ================== PROVABLY-FAIR HELPERS ==================
let currentServerSeed = crypto.randomBytes(32).toString('hex');
let currentSeedId = String(Date.now());
let currentSeedHash = crypto.createHash('sha256').update(currentServerSeed).digest('hex');

function rotateSeed() {
  currentServerSeed = crypto.randomBytes(32).toString('hex');
  currentSeedId = String(Date.now());
  currentSeedHash = crypto.createHash('sha256').update(currentServerSeed).digest('hex');
}
function computeOutcomeFromSeeds(serverSeed, clientSeed) {
  const h = crypto.createHmac('sha256', serverSeed).update(String(clientSeed || '')).digest('hex');
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return v < 0.5 ? 'heads' : 'tails';
}

// Mines board generator
function generateMinesBoard(serverSeed, clientSeed, bombCount) {
  const h = crypto.createHmac('sha256', serverSeed).update(String(clientSeed || '')).digest('hex');
  const board = Array(25).fill(0);
  const bombIndices = new Set();
  let rngState = parseInt(h.slice(0, 8), 16);
  while (bombIndices.size < bombCount) {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    const idx = rngState % 25;
    bombIndices.add(idx);
  }
  bombIndices.forEach(idx => (board[idx] = 1));
  return board;
}

// ================== FETCHER ==================
let fetcher = null;
if (typeof globalThis.fetch === 'function') fetcher = globalThis.fetch.bind(globalThis);
else { try { fetcher = require('node-fetch'); } catch (e) { fetcher = null; } }

// ================== DISCORD OAUTH ==================
app.get('/auth/discord', (req, res) => {
  if (!config.discordClientId) return res.status(500).send('Discord OAuth not configured');
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirect,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  if (!fetcher) return res.status(500).send('Server fetch not available');
  if (!config.discordClientId || !config.discordClientSecret) return res.status(500).send('Discord credentials not set');
  try {
    const params = new URLSearchParams();
    params.append('client_id', config.discordClientId);
    params.append('client_secret', config.discordClientSecret);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', config.discordRedirect);
    const tokenRes = await fetcher('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) return res.status(500).send('Failed to get token');

    const userRes = await fetcher('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const userJson = await userRes.json();
    const discordId = String(userJson.id);
    const username = `${userJson.username}#${userJson.discriminator}`;
    const avatarUrl = userJson.avatar 
      ? `https://cdn.discordapp.com/avatars/${userJson.id}/${userJson.avatar}.png?size=128`
      : null;

    db.serialize(() => {
      db.run('INSERT OR IGNORE INTO users (discord_id, username, balance, avatar_url) VALUES (?, ?, ?, ?)', [discordId, username, 0, avatarUrl]);
      db.run('UPDATE users SET username = ?, avatar_url = ? WHERE discord_id = ?', [username, avatarUrl, discordId]);
      db.get('SELECT id FROM users WHERE discord_id = ?', [discordId], (err, row) => {
        if (err || !row) return res.status(500).send('User create error');
        const userId = row.id;
        const token = createSession({ type: 'user', user: username, discordId, userId });
        res.cookie('userToken', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24*60*60*1000, sameSite: 'lax' });
        res.redirect(`/index.html?token=${token}`);
      });
    });
  } catch (e) { console.error('OAuth error', e); res.status(500).send('OAuth error'); }
});

// ================== CRASH STORE ==================
let crashStore = { bank: 1000000, history: [] };
let activeCrashRound = null;
try { if (fs.existsSync(CRASH_DATA_FILE)) crashStore = JSON.parse(fs.readFileSync(CRASH_DATA_FILE)); } catch (e) {}
function saveCrashStore(){ try{ fs.writeFileSync(CRASH_DATA_FILE, JSON.stringify(crashStore, null, 2)); } catch (e){ console.warn('crash store save err', e); } }

// ================== FLIP ENDPOINT ==================
app.post('/api/flip', (req, res) => {
  const body = req.body || {};
  const clientSeed = body.clientSeed || crypto.randomBytes(8).toString('hex');
  const bet = Number(body.bet || 0);
  const userToken = getUserToken(req);
  let userDiscordId = null;
  let userDisplay = body.user || null;
  let dbUserId = null;

  const s = validateSession(userToken);
  if (s && s.type === 'user' && s.discordId) {
    userDiscordId = s.discordId;
    userDisplay = s.user || userDisplay;
  }

  const minBet = Number(config.minBet || 100000);
  if (bet && bet < minBet) return res.status(400).json({ error: 'min_bet', minBet });

  function proceedWithOutcome(serverSeedUsed) {
    const outcome = computeOutcomeFromSeeds(serverSeedUsed, clientSeed);
    const ts = Date.now();

    if (bet && userDiscordId) {
      db.get('SELECT id, balance FROM users WHERE discord_id = ?', [userDiscordId], (err, row) => {
        if (err) return res.status(500).json({ error: 'db' });
        if (!row) return res.status(400).json({ error: 'no_user' });
        dbUserId = row.id;
        let newBal = Number(row.balance || 0);
        if (newBal < bet) return res.status(400).json({ error: 'insufficient' });
        newBal -= bet;

        const chosen = String(body.choice || '').toLowerCase();
        let payout = 0;
        let won = false;
        if (chosen && outcome === chosen) {
          payout = Math.floor(bet * 1.96);
          newBal += payout;
          won = true;
        }

        db.run('UPDATE users SET balance = ? WHERE id = ?', [newBal, dbUserId], (uerr) => {
          if (uerr) return res.status(500).json({ error: 'db' });
          db.run(
            'INSERT INTO flips (outcome, user, ts, serverSeed, clientSeed, seedId, bet) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [outcome, userDisplay, ts, serverSeedUsed, clientSeed, currentSeedId, bet],
            function (ierr) {
              if (ierr) return res.status(500).json({ error: 'db' });
              rotateSeed();
              return res.json({ id: this.lastID, outcome, user: userDisplay, ts, serverSeed: serverSeedUsed, seedHash: crypto.createHash('sha256').update(serverSeedUsed).digest('hex'), seedId: currentSeedId, balance: newBal, payout, won });
            }
          );
        });
      });
    } else {
      db.run(
        'INSERT INTO flips (outcome, user, ts, serverSeed, clientSeed, seedId) VALUES (?, ?, ?, ?, ?, ?)',
        [outcome, userDisplay, ts, serverSeedUsed, clientSeed, currentSeedId],
        function (ierr) {
          if (ierr) return res.status(500).json({ error: 'db' });
          rotateSeed();
          return res.json({ id: this.lastID, outcome, user: userDisplay, ts, serverSeed: serverSeedUsed, seedHash: crypto.createHash('sha256').update(serverSeedUsed).digest('hex'), seedId: currentSeedId });
        }
      );
    }
  }

  if (userDiscordId) {
    db.get('SELECT banned FROM users WHERE discord_id = ?', [userDiscordId], (berr, brow) => {
      if (berr) return res.status(500).json({ error: 'db' });
      if (brow && brow.banned) return res.status(403).json({ error: 'banned' });
      proceedWithOutcome(currentServerSeed);
    });
  } else { proceedWithOutcome(currentServerSeed); }
});

// ================== PROVABLY FAIR SLOT ==================

// helper: deterministic random
function provablyRandom(serverSeed, clientSeed, nonce){
  const hmac = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return parseInt(hmac.slice(0, 8), 16)/0xffffffff;
}

// spin simulator
function spinGrid(){
  const symbols = ['🍒','🍋','🍊','🍉','⭐','💎'];
  const grid = [];
  for(let i=0;i<9;i++) grid.push(symbols[Math.floor(Math.random()*symbols.length)]);
  return grid;
}

// evaluate wins
function evalSpin(grid, bet){
  let payout = 0;
  let wins = [];
  if(grid[0]===grid[1] && grid[1]===grid[2]){ payout = bet*2; wins.push('row1'); }
  if(grid[3]===grid[4] && grid[4]===grid[5]){ payout = Math.max(payout, bet*2); wins.push('row2'); }
  if(grid[6]===grid[7] && grid[7]===grid[8]){ payout = Math.max(payout, bet*2); wins.push('row3'); }
  return { payout, wins };
}

let users = {}; // memory map userId -> { balance, serverSeed, nonce }

// PROVABLY FAIR SLOT ROUTE
app.post("/api/slot_pf", async (req,res)=>{
  const { userId, bet, clientSeed } = req.body;
  if(!users[userId]) users[userId]={ balance:1000000, serverSeed:crypto.randomBytes(32).toString('hex'), nonce:0 };
  const user = users[userId];
  if(user.balance<bet) return res.status(400).json({ error:'insufficient' });

  user.balance-=bet;

  const rnd = provablyRandom(user.serverSeed, clientSeed||'default', user.nonce++);
  Math.random=()=>rnd; // deterministic for spin

  const grid=spinGrid();
  const result=evalSpin(grid, bet);
  if(result.payout>0) user.balance+=result.payout;

  res.json({
    bet, payout:result.payout, profit:result.payout-bet, grid, wins:result.wins,
    balance:user.balance,
    fairness:{ clientSeed, nonce:user.nonce-1, serverSeedHash:crypto.createHash('sha256').update(user.serverSeed).digest('hex') }
  });
});

// ================== START SERVER ==================
function startServer(port=PORT){
  const server = http.createServer(app);
  server.listen(port,'0.0.0.0',()=>console.log(`Server running on ${port}`));
  return server;
}

if(require.main===module){ startServer(); }

module.exports={ startServer };

