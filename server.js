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

// load config (config.json overrides environment)
let config = {
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin',
  adminPassHash: null,
};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  const j = JSON.parse(raw);
  config = Object.assign(config, j);
} catch (e) {
  // missing or invalid config.json is fine; use defaults
}

// OAuth / Discord config
config.discordClientId = process.env.DISCORD_CLIENT_ID || config.discordClientId || null;
config.discordClientSecret = process.env.DISCORD_CLIENT_SECRET || config.discordClientSecret || null;
config.discordRedirect = process.env.DISCORD_REDIRECT || config.discordRedirect || `http://localhost:${PORT}/auth/discord/callback`;

// Prepare hashed password in memory. If config contains `adminPassHash`, use it;
// otherwise hash the provided `adminPass` and keep the hash in memory.
let adminPassHash = null;
if (config.adminPassHash) {
  adminPassHash = String(config.adminPassHash);
} else if (config.adminPass) {
  // synchronous hash on startup (low frequency)
  const salt = bcrypt.genSaltSync(10);
  adminPassHash = bcrypt.hashSync(String(config.adminPass), salt);
}

// In-memory session tokens: token -> { type: 'admin'|'user', user, discordId, userId, exp }
const sessions = new Map();

function createSession(payload = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + 1000 * 60 * 60 * 24; // 24 hours for users/admins
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

// helper: read cookie by name
function getCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const parts = raw.split(';').map(s => s.trim());
  const m = parts.find(p => p.startsWith(name + '='));
  if (!m) return null;
  return decodeURIComponent(m.split('=')[1]);
}

// helper: get user token prioritizing HttpOnly cookie, then header, then query
function getUserToken(req) {
  return getCookie(req, 'userToken') || req.get('x-user-token') || req.query.token || null;
}

// Middleware: Check if accessing /index.html without token â redirect to /login.html
app.get('/index.html', (req, res, next) => {
  const token = req.query.token || req.get('x-user-token') || getCookie(req, 'userToken');
  if (!token && !req.session) {
    // No token in query/header/cookie, redirect to login
    return res.redirect('/login.html');
  }
  next();
});

// simple static serve of current folder
app.use(express.static(path.join(__dirname)));

// initialize sqlite DB
const DB_FILE = path.join(__dirname, 'flips.db');
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS flips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outcome TEXT,
      user TEXT,
      ts INTEGER
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE,
      username TEXT,
      balance INTEGER DEFAULT 0,
      avatar_url TEXT
    )`
  );
  // attempt to add columns to flips for provable fairness; ignore errors
  db.run(`ALTER TABLE flips ADD COLUMN serverSeed TEXT`, () => {});
  db.run(`ALTER TABLE flips ADD COLUMN clientSeed TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE flips ADD COLUMN seedId TEXT`, () => {});
  db.run(`ALTER TABLE flips ADD COLUMN bet INTEGER`, () => {});
  
  // Mines games table
  db.run(
    `CREATE TABLE IF NOT EXISTS mines_games (
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
    )`
  );
});

// Provably-fair seed state
let currentServerSeed = crypto.randomBytes(32).toString('hex');
let currentSeedId = String(Date.now());
function seedHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}
let currentSeedHash = seedHash(currentServerSeed);

function rotateSeed() {
  currentServerSeed = crypto.randomBytes(32).toString('hex');
  currentSeedId = String(Date.now());
  currentSeedHash = seedHash(currentServerSeed);
}

function computeOutcomeFromSeeds(serverSeed, clientSeed) {
  const h = crypto.createHmac('sha256', serverSeed).update(String(clientSeed || '')).digest('hex');
  // use first 8 chars -> 32-bit int
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return v < 0.5 ? 'heads' : 'tails';
}

// Generate Mines board from serverSeed + clientSeed (provably-fair)
function generateMinesBoard(serverSeed, clientSeed, bombCount) {
  const h = crypto.createHmac('sha256', serverSeed).update(String(clientSeed || '')).digest('hex');
  const board = Array(25).fill(0);
  const bombIndices = new Set();
  
  // Use hash to seed RNG for bomb placement
  let rngState = parseInt(h.slice(0, 8), 16);
  while (bombIndices.size < bombCount) {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; // LCG
    const idx = rngState % 25;
    bombIndices.add(idx);
  }
  bombIndices.forEach(idx => (board[idx] = 1));
  return board;
}

// setup fetcher (node may have global fetch)
let fetcher = null;
if (typeof globalThis.fetch === 'function') fetcher = globalThis.fetch.bind(globalThis);
else {
  try {
    fetcher = require('node-fetch');
  } catch (e) {
    fetcher = null;
  }
}

// Discord OAuth start
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

// Discord OAuth callback
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

    // create or update user in DB
    db.serialize(() => {
      db.run('INSERT OR IGNORE INTO users (discord_id, username, balance, avatar_url) VALUES (?, ?, ?, ?)', [discordId, username, 0, avatarUrl]);
      db.run('UPDATE users SET username = ?, avatar_url = ? WHERE discord_id = ?', [username, avatarUrl, discordId]);
      db.get('SELECT id FROM users WHERE discord_id = ?', [discordId], (err, row) => {
        if (err || !row) return res.status(500).send('User create error');
        const userId = row.id;
        const token = createSession({ type: 'user', user: username, discordId, userId });
        // set HttpOnly cookie for improved token security (still include query token for compatibility)
        res.cookie('userToken', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24*60*60*1000, sameSite: 'lax' });
        // redirect back to main page with token
        res.redirect(`/index.html?token=${token}`);
      });
    });
  } catch (e) {
    console.error('OAuth error', e);
    res.status(500).send('OAuth error');
  }
});

// --- Crash: persistent store & verify endpoint (integrated)
let crashStore = { bank: 1000000, history: [] };
// reference to active round so clients can verify while it's running
let activeCrashRound = null;
try { if (fs.existsSync(CRASH_DATA_FILE)) crashStore = JSON.parse(fs.readFileSync(CRASH_DATA_FILE)); } catch (e) { console.warn('crash store read error', e); }
function saveCrashStore(){ try{ fs.writeFileSync(CRASH_DATA_FILE, JSON.stringify(crashStore, null, 2)); } catch (e){ console.warn('crash store save err', e); } }

app.get('/crash/verify/:roundId', (req, res) => {
  const id = req.params.roundId;
  // check persisted history first
  const hist = crashStore.history.find(h => h.id === id);
  if (hist) return res.json({ id: hist.id, serverSeed: hist.serverSeed, seedHash: hist.seedHash, crashMultiplier: hist.crashMultiplier });
  // fall back to active round (allow verifying the current round before it finishes)
  if (activeCrashRound && activeCrashRound.id === id) {
    return res.json({ id: activeCrashRound.id, serverSeed: activeCrashRound.serverSeed, seedHash: activeCrashRound.seedHash, crashMultiplier: activeCrashRound.crashMultiplier, bettingEnds: activeCrashRound.bettingEnds });
  }
  return res.status(404).json({ error: 'not found', activeRoundId: activeCrashRound ? activeCrashRound.id : null });
});

app.post('/api/flip', (req, res) => {
  const body = req.body || {};
  const clientSeed = body.clientSeed || crypto.randomBytes(8).toString('hex');
  const bet = Number(body.bet || 0);
  const userToken = getUserToken(req);
  let userDiscordId = null;
  let userDisplay = body.user || null;
  let dbUserId = null;

  // identify user via session token
  const s = validateSession(userToken);
  if (s && s.type === 'user' && s.discordId) {
    userDiscordId = s.discordId;
    userDisplay = s.user || userDisplay;
  }

  // enforce min bet if provided
  const minBet = Number(config.minBet || 100000);
  if (bet && bet < minBet) return res.status(400).json({ error: 'min_bet', minBet });

  // load user record if discord id present
  function proceedWithOutcome(serverSeedUsed) {
    const outcome = computeOutcomeFromSeeds(serverSeedUsed, clientSeed);
    const ts = Date.now();

    // handle balance update if bet and user
    if (bet && userDiscordId) {
      db.get('SELECT id, balance FROM users WHERE discord_id = ?', [userDiscordId], (err, row) => {
        if (err) return res.status(500).json({ error: 'db' });
        if (!row) return res.status(400).json({ error: 'no_user' });
        dbUserId = row.id;
        let newBal = Number(row.balance || 0);
        if (newBal < bet) return res.status(400).json({ error: 'insufficient' });

        // deduct the bet immediately
        newBal -= bet;

        // determine win by comparing server outcome with client's chosen side
        const chosen = String(body.choice || '').toLowerCase();
        let payout = 0;
        let won = false;
        if (chosen && outcome === chosen) {
          // payout: full return = floor(bet * 1.96) [98% RTP]
          payout = Math.floor(bet * 1.96);
          newBal += payout;
          won = true;
        }

        db.run('UPDATE users SET balance = ? WHERE id = ?', [newBal, dbUserId], (uerr) => {
          if (uerr) return res.status(500).json({ error: 'db' });
          // store flip including seeds and bet
          db.run(
            'INSERT INTO flips (outcome, user, ts, serverSeed, clientSeed, seedId, bet) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [outcome, userDisplay, ts, serverSeedUsed, clientSeed, currentSeedId, bet],
            function (ierr) {
              if (ierr) return res.status(500).json({ error: 'db' });
              // rotate seed after committing
              rotateSeed();
              return res.json({ id: this.lastID, outcome, user: userDisplay, ts, serverSeed: serverSeedUsed, seedHash: seedHash(serverSeedUsed), seedId: currentSeedId, balance: newBal, payout, won });
            }
          );
        });
      });
    } else {
      // anonymous/no-bet flip
      db.run(
        'INSERT INTO flips (outcome, user, ts, serverSeed, clientSeed, seedId) VALUES (?, ?, ?, ?, ?, ?)',
        [outcome, userDisplay, ts, serverSeedUsed, clientSeed, currentSeedId],
        function (ierr) {
          if (ierr) return res.status(500).json({ error: 'db' });
          rotateSeed();
          return res.json({ id: this.lastID, outcome, user: userDisplay, ts, serverSeed: serverSeedUsed, seedHash: seedHash(serverSeedUsed), seedId: currentSeedId });
        }
      );
    }
  }

  // use currentServerSeed committed before flip
  if (userDiscordId) {
    db.get('SELECT banned FROM users WHERE discord_id = ?', [userDiscordId], (berr, brow) => {
      if (berr) return res.status(500).json({ error: 'db' });
      if (brow && brow.banned) return res.status(403).json({ error: 'banned' });
      proceedWithOutcome(currentServerSeed);
    });
  } else {
    proceedWithOutcome(currentServerSeed);
  }
});

// provably-fair seed endpoint: returns current seed hash and id (commitment)
app.get('/api/seed', (req, res) => {
  res.json({ seedHash: currentSeedHash, seedId: currentSeedId });
});

// return current user info (requires x-user-token)
app.get('/api/me', (req, res) => {
  const token = req.get('x-user-token') || req.query.token || getCookie(req, 'userToken');
  const s = validateSession(token);
  if (!s || s.type !== 'user') return res.status(401).json({ error: 'unauthorized' });
  db.get('SELECT id, discord_id, username, balance, avatar_url, banned FROM users WHERE discord_id = ?', [s.discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(404).json({ error: 'no_user' });
    res.json({ id: row.id, discordId: row.discord_id, username: row.username, balance: Number(row.balance || 0), avatar_url: row.avatar_url, banned: !!row.banned, token });
  });
});

// logout endpoint: clears cookie and server-side session
app.get('/auth/logout', (req, res) => {
  const token = req.get('x-user-token') || req.query.token || getCookie(req, 'userToken');
  if (token) sessions.delete(token);
  try { res.clearCookie('userToken'); } catch (e) {}
  res.redirect('/login.html');
});

// ADMIN: set/add balance for a user (by discord id)
app.post('/api/admin/setBalance', (req, res) => {
  const s = validateSession(req.get('x-admin-token'));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const discordId = body.discordId;
  const amount = Number(body.amount || 0);
  if (!discordId) return res.status(400).json({ error: 'missing_discordId' });
  db.get('SELECT id FROM users WHERE discord_id = ?', [discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(404).json({ error: 'no_user' });
    db.run('UPDATE users SET balance = ? WHERE id = ?', [amount, row.id], (uerr) => {
      if (uerr) return res.status(500).json({ error: 'db' });
      res.json({ ok: true });
    });
  });
});

// ADMIN: add to balance
app.post('/api/admin/addBalance', (req, res) => {
  const s = validateSession(req.get('x-admin-token'));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const discordId = body.discordId;
  const amount = Number(body.amount || 0);
  if (!discordId) return res.status(400).json({ error: 'missing_discordId' });
  db.get('SELECT id, balance FROM users WHERE discord_id = ?', [discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(404).json({ error: 'no_user' });
    const newB = Number(row.balance || 0) + amount;
    db.run('UPDATE users SET balance = ? WHERE id = ?', [newB, row.id], (uerr) => {
      if (uerr) return res.status(500).json({ error: 'db' });
      res.json({ ok: true, balance: newB });
    });
  });
});

// ADMIN: list users
app.get('/api/admin/users', (req, res) => {
  const s = validateSession(req.get('x-admin-token'));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  db.all('SELECT id, discord_id, username, balance, avatar_url, banned FROM users ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'db' });
    res.json(rows.map(r => ({ id: r.id, discordId: r.discord_id, username: r.username, balance: Number(r.balance||0), avatar_url: r.avatar_url, banned: !!r.banned })));
  });
});

// ADMIN: ban user
app.post('/api/admin/ban', (req, res) => {
  const s = validateSession(req.get('x-admin-token'));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const discordId = (req.body && req.body.discordId) ? String(req.body.discordId) : null;
  if (!discordId) return res.status(400).json({ error: 'missing_discordId' });
  db.run('UPDATE users SET banned = 1 WHERE discord_id = ?', [discordId], function(err) {
    if (err) return res.status(500).json({ error: 'db' });
    res.json({ ok: true });
  });
});

// ADMIN: unban user
app.post('/api/admin/unban', (req, res) => {
  const s = validateSession(req.get('x-admin-token'));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  const discordId = (req.body && req.body.discordId) ? String(req.body.discordId) : null;
  if (!discordId) return res.status(400).json({ error: 'missing_discordId' });
  db.run('UPDATE users SET banned = 0 WHERE discord_id = ?', [discordId], function(err) {
    if (err) return res.status(500).json({ error: 'db' });
    res.json({ ok: true });
  });
});

// Mines game endpoint: POST /api/mines/play
app.post('/api/mines/play', (req, res) => {
  const userToken = getUserToken(req);
  const s = validateSession(userToken);
  if (!s || s.type !== 'user' || !s.discordId) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const bet = Number(body.bet || 0);
  const bombCount = Number(body.bombCount || 0);
  const revealedIndex = Number(body.revealedIndex);
  const gameId = body.gameId;
  const clientSeed = body.clientSeed || crypto.randomBytes(32).toString('hex');

  const minBet = Number(config.minBet || 100000);
  if (bet < minBet) return res.status(400).json({ error: 'min_bet', minBet });
  if (bombCount < 1 || bombCount > 24) return res.status(400).json({ error: 'invalid_bomb_count' });
  if (revealedIndex < 0 || revealedIndex > 24) return res.status(400).json({ error: 'invalid_index' });

  db.get('SELECT id, balance, banned, username FROM users WHERE discord_id = ?', [s.discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(400).json({ error: 'no_user' });
    if (row.banned) return res.status(403).json({ error: 'banned' });
    if (row.balance < bet) return res.status(400).json({ error: 'insufficient' });

    const userId = row.id;
    const username = row.username;

    // First move: create game with new seeds
    if (!gameId) {
      const serverSeed = crypto.randomBytes(32).toString('hex');
      const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
      const board = generateMinesBoard(serverSeed, clientSeed, bombCount);

      const newBal = Number(row.balance) - bet;
      db.run('UPDATE users SET balance = ? WHERE id = ?', [newBal, userId], (uerr) => {
        if (uerr) return res.status(500).json({ error: 'db' });
      });

      const cell = board[revealedIndex];
      
      if (cell === 1) {
        // BUST on first move
        db.run(
          `INSERT INTO mines_games (user_id, discord_id, username, bet, bomb_count, server_seed, client_seed, seed_hash, board, moves, outcome, multiplier, payout, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, s.discordId, username, bet, bombCount, serverSeed, clientSeed, seedHash, JSON.stringify(board), JSON.stringify([revealedIndex]), 'bust', 1, 0, Date.now()],
          function(ierr) {
            if (ierr) {
              console.error('DB insert error:', ierr);
              return res.status(500).json({ error: 'db_insert' });
            }
            const gameRowId = this.lastID;
            res.json({ 
              gameId: gameRowId, 
              outcome: 'bust', 
              revealedIndex, 
              cell: 'bomb',
              board: board,
              multiplier: 1, 
              payout: 0, 
              balance: newBal, 
              seedHash,
              serverSeed 
            });
          }
        );
        return;
      }

      // SAFE on first move
      // For first click: chance = safeFields / totalFields = (25 - bombCount) / 25
      const safeFieldsFirst = 25 - bombCount;
      const chanceFirst = safeFieldsFirst / 25;
      // Fair multiplier with 3% house edge: (1 / chance) * 0.97
      const multiplier = (1 / chanceFirst) * 0.97;
      const potentialPayout = Math.floor(bet * multiplier);

      db.run(
        `INSERT INTO mines_games (user_id, discord_id, username, bet, bomb_count, server_seed, client_seed, seed_hash, board, moves, outcome, multiplier, payout, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, s.discordId, username, bet, bombCount, serverSeed, clientSeed, seedHash, JSON.stringify(board), JSON.stringify([revealedIndex]), 'playing', multiplier, potentialPayout, Date.now()],
        function(ierr) {
          if (ierr) {
            console.error('DB insert error:', ierr);
            return res.status(500).json({ error: 'db_insert' });
          }
          const gameRowId = this.lastID;
          res.json({ 
            gameId: gameRowId, 
            outcome: 'safe', 
            revealedIndex, 
            cell: 'diamond', 
            multiplier: multiplier.toFixed(2), 
            potentialPayout, 
            seedHash,
            serverSeed,
            board: board
          });
        }
      );
      return;
    }

    // Subsequent moves: retrieve game and continue
    db.get('SELECT * FROM mines_games WHERE id = ? AND user_id = ?', [gameId, userId], (err, game) => {
      if (err) return res.status(500).json({ error: 'db' });
      if (!game) return res.status(400).json({ error: 'game_not_found' });

      const board = JSON.parse(game.board || '[]');
      const moves = JSON.parse(game.moves || '[]');

      if (game.outcome !== 'playing') {
        return res.status(400).json({ error: 'game_ended' });
      }

      const cell = board[revealedIndex];
      moves.push(revealedIndex);

      if (cell === 1) {
        // BUST
        db.run(
          `UPDATE mines_games SET outcome = ?, moves = ?, payout = ? WHERE id = ?`,
          ['bust', JSON.stringify(moves), 0, gameId],
          (uerr) => {
            if (uerr) console.error('DB update error:', uerr);
          }
        );
        return res.json({ 
          gameId, 
          outcome: 'bust', 
          revealedIndex, 
          cell: 'bomb', 
          multiplier: 1, 
          payout: 0, 
          balance: Number(row.balance) - bet,
          board: board,
          serverSeed: game.server_seed
        });
      }

      // SAFE: calculate multiplier for subsequent moves
      // Chance for current click: safeFieldsRemaining / totalFieldsRemaining
      // where safeFieldsRemaining = fields with no bomb that haven't been clicked yet
      const safeCount = moves.length;
      const safeFieldsRemaining = 25 - bombCount - safeCount;
      const fieldsRemaining = 25 - safeCount;
      const chance = safeFieldsRemaining / fieldsRemaining;
      // Fair multiplier: previous_multiplier / chance (house edge already included)
      const multiplier = Number(game.multiplier || 1) / chance;
      const potentialPayout = Math.floor(Number(game.bet) * multiplier);

      db.run(
        `UPDATE mines_games SET moves = ?, multiplier = ?, payout = ? WHERE id = ?`,
        [JSON.stringify(moves), multiplier, potentialPayout, gameId],
        (uerr) => {
          if (uerr) console.error('DB update error:', uerr);
        }
      );

      res.json({ 
        gameId, 
        outcome: 'safe', 
        revealedIndex, 
        cell: 'diamond', 
        multiplier: multiplier.toFixed(2), 
        potentialPayout,
        board: board,
        serverSeed: game.server_seed
      });
    });
  });
});

// Mines cashout endpoint
app.post('/api/mines/cashout', (req, res) => {
  const userToken = getUserToken(req);
  const s = validateSession(userToken);
  if (!s || s.type !== 'user' || !s.discordId) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const gameId = body.gameId;
  const multiplier = Number(body.multiplier || 1);

  db.get('SELECT id, balance FROM users WHERE discord_id = ?', [s.discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(400).json({ error: 'no_user' });

    const userId = row.id;

    db.get('SELECT * FROM mines_games WHERE id = ? AND user_id = ?', [gameId, userId], (err, game) => {
      if (err) return res.status(500).json({ error: 'db' });
      if (!game) return res.status(400).json({ error: 'game_not_found' });
      if (game.outcome !== 'playing') return res.status(400).json({ error: 'game_ended' });

      const payout = Math.floor(Number(game.bet) * multiplier);
      const newBal = Number(row.balance) + payout;

      db.run(
        `UPDATE mines_games SET outcome = ?, payout = ? WHERE id = ?`,
        ['cashout', payout, gameId],
        ['cashout', payout, gameId],
        (uerr) => {
          if (uerr) return res.status(500).json({ error: 'db_update' });

          db.run('UPDATE users SET balance = ? WHERE id = ?', [newBal, userId], (uerr2) => {
            if (uerr2) return res.status(500).json({ error: 'db_balance' });
            res.json({ ok: true, payout, balance: newBal });
          });
        }
      );
    });
  });
});

// Mines verify endpoint: GET /api/mines/verify/:gameId
app.get('/api/mines/verify/:gameId', (req, res) => {
  const userToken = getUserToken(req);
  const s = validateSession(userToken);
  if (!s || s.type !== 'user' || !s.discordId) return res.status(401).json({ error: 'unauthorized' });

  const gameId = req.params.gameId;

  db.get('SELECT id FROM users WHERE discord_id = ?', [s.discordId], (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(400).json({ error: 'no_user' });

    const userId = row.id;

    db.get('SELECT * FROM mines_games WHERE id = ? AND user_id = ?', [gameId, userId], (err, game) => {
      if (err) return res.status(500).json({ error: 'db' });
      if (!game) return res.status(404).json({ error: 'game_not_found' });

      // Verify board: reconstruct from seeds
      const board = JSON.parse(game.board || '[]');
      const reconstructed = generateMinesBoard(game.server_seed, game.client_seed, game.bomb_count);
      const boardMatch = JSON.stringify(board) === JSON.stringify(reconstructed);

      // Verify seed hash
      const computedHash = crypto.createHash('sha256').update(game.server_seed).digest('hex');
      const seedHashMatch = computedHash === game.seed_hash;

      res.json({
        gameId: game.id,
        bet: game.bet,
        bombCount: game.bomb_count,
        outcome: game.outcome,
        multiplier: game.multiplier,
        payout: game.payout,
        serverSeed: game.server_seed,
        clientSeed: game.client_seed,
        seedHash: game.seed_hash,
        board,
        moves: JSON.parse(game.moves || '[]'),
        verification: {
          boardReconstructed: boardMatch,
          seedHashVerified: seedHashMatch,
          boardValid: boardMatch && seedHashMatch,
        },
      });
    });
  });
});

// admin login endpoint: returns a temporary token
app.post('/api/admin/login', (req, res) => {
  const user = req.body && req.body.user ? String(req.body.user) : '';
  const pass = req.body && req.body.pass ? String(req.body.pass) : '';
  if (user !== config.adminUser) return res.status(401).json({ error: 'unauthorized' });
  if (!adminPassHash) return res.status(500).json({ error: 'no-admin' });
  if (!bcrypt.compareSync(pass, adminPassHash)) return res.status(401).json({ error: 'unauthorized' });
  const token = createSession({ type: 'admin', user });
  res.json({ token, expiresIn: 30 * 60 });
});

app.get('/api/logs', (req, res) => {
  // Support either token auth or legacy user/pass headers
  const token = req.get('x-admin-token');
  if (token && validateSession(token)) {
    db.all('SELECT id, outcome, user, ts FROM flips ORDER BY ts DESC LIMIT 200', (err, rows) => {
      if (err) return res.status(500).json({ error: 'db' });
      res.json(rows);
    });
    return;
  }

  const user = req.get('x-admin-user') || '';
  const pass = req.get('x-admin-pass') || '';
  if (user !== config.adminUser || !bcrypt.compareSync(pass, adminPassHash))
    return res.status(401).json({ error: 'unauthorized' });
  db.all('SELECT id, outcome, user, ts FROM flips ORDER BY ts DESC LIMIT 200', (err, rows) => {
    if (err) return res.status(500).json({ error: 'db' });
    res.json(rows);
  });
});

function startServer(port = PORT) {
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  function broadcast(obj){
    const s = JSON.stringify(obj);
    wss.clients.forEach(c=>{ if(c.readyState === WebSocket.OPEN) c.send(s); });
  }

  // crash round state
  let currentRound = null;
  let roundTicker = null;

  function hmacHex(key, msg){ return crypto.createHmac('sha256', key).update(msg).digest('hex'); }
  function sha256hex(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

  function computeCrashFromSeed(serverSeed){
    const h = hmacHex(serverSeed, 'crash');
    const v = parseInt(h.slice(0,13), 16) / Math.pow(2, 52);
    const raw = Math.max(1.0, Math.floor((1 / (1 - v)) * 100) / 100);
    const withEdge = Math.max(1.0, Math.floor(raw * 0.97 * 100) / 100);
    return Math.min(withEdge, 10000);
  }

  function startNewRound(){
    if (roundTicker) { clearInterval(roundTicker); roundTicker = null; }
    const id = crypto.randomBytes(8).toString('hex');
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const seedHash = sha256hex(serverSeed);
    const crashMultiplier = computeCrashFromSeed(serverSeed);
    const bettingEnds = Date.now() + 20000; // 20s betting window
    currentRound = { id, serverSeed, seedHash, crashMultiplier, bets: {}, status: 'betting', created: Date.now(), bettingEnds };
    // expose active round for verify endpoint
    activeCrashRound = currentRound;
    const minBetValue = Number(config.minBet || 100000);
    broadcast({ type: 'round:start', id: currentRound.id, seedHash: currentRound.seedHash, bettingEnds: bettingEnds, bank: crashStore.bank, minBet: minBetValue });
    setTimeout(() => runRound(currentRound), bettingEnds - Date.now());
  }

  function runRound(round){
    round.status = 'running';
    const start = Date.now();
    const crashAt = round.crashMultiplier;
    let crashed = false;
    broadcast({ type: 'round:run', id: round.id });
    roundTicker = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const cur = Math.max(1, Math.pow(1.07, elapsed));
      const curRounded = Math.floor(cur * 100) / 100;
      if (!crashed && curRounded >= crashAt) {
        crashed = true;
        round.status = 'crashed';
        broadcast({ type: 'round:crash', id: round.id, crashMultiplier: crashAt });
        // store history
        crashStore.history.unshift({ id: round.id, crashMultiplier: round.crashMultiplier, serverSeed: round.serverSeed, seedHash: round.seedHash, bets: round.bets, timestamp: Date.now() });
        if (crashStore.history.length > 50) crashStore.history.pop();
        saveCrashStore();
        // active round finished
        if (activeCrashRound && activeCrashRound.id === round.id) activeCrashRound = null;
        clearInterval(roundTicker); roundTicker = null;
        // next round
        setTimeout(startNewRound, 4000);
        return;
      }
      broadcast({ type: 'round:tick', id: round.id, multiplier: curRounded });
    }, 100);
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'info', bank: crashStore.bank, history: crashStore.history.slice(0,10) }));
    console.log('Crash WS: client connected');
    // if a round is already active, send its state so new clients can participate
    if (currentRound) {
      ws.send(JSON.stringify({ type: 'round:start', id: currentRound.id, seedHash: currentRound.seedHash, bettingEnds: (currentRound.created || Date.now()) + 5000, bank: crashStore.bank }));
      if (currentRound.status === 'running') ws.send(JSON.stringify({ type: 'round:run', id: currentRound.id }));
    }
    ws.on('message', (m) => {
      try { const obj = JSON.parse(m); console.log('Crash WS recv:', obj.type, obj); } catch (e) { console.log('Crash WS recv non-json'); }
    });
    ws.on('message', (msg) => {
      let data = null; try { data = JSON.parse(msg); } catch (e) { return; }
      if (!data || !data.type) return;
      if (data.type === 'placeBet'){
        const { clientId, amount, roundId } = data;
        if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'betting'){
          return ws.send(JSON.stringify({ type: 'bet:rejected', reason: 'no active betting phase' }));
        }
        const a = Number(amount) || 0; if (a <= 0) return;
        // enforce min bet
        const minBetValue = Number(config.minBet || 100000);
        if (a < minBetValue) return ws.send(JSON.stringify({ type: 'bet:rejected', reason: 'min_bet', minBet: minBetValue }));
        currentRound.bets[clientId] = { amount: a, cashed: false, payout: 0 };
        ws.send(JSON.stringify({ type: 'bet:accepted', clientId, amount: a }));
        broadcast({ type: 'bet:update', roundId: currentRound.id, bets: Object.values(currentRound.bets).map(b=>b.amount).reduce((s,n)=>s+n,0) });
      }
      if (data.type === 'cashout'){
        const { clientId, roundId } = data;
        if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'running') return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'not running' }));
        const betRec = currentRound.bets[clientId];
        if (!betRec || betRec.cashed) return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'no bet or already cashed' }));
        const elapsed = (Date.now() - (currentRound.created || Date.now())) / 1000;
        const cur = Math.max(1, Math.pow(1.07, elapsed));
        const curRounded = Math.floor(cur * 100) / 100;
        if (curRounded >= currentRound.crashMultiplier) return ws.send(JSON.stringify({ type: 'cashout:rejected', reason: 'too late - crashed' }));
        const payout = Math.floor(betRec.amount * curRounded * 100) / 100;
        if (payout > crashStore.bank) {
          const capped = Math.floor(crashStore.bank * 100) / 100;
          betRec.cashed = true; betRec.payout = capped; crashStore.bank = 0; saveCrashStore();
          ws.send(JSON.stringify({ type: 'cashout:ok', clientId, payout: capped })); broadcast({ type: 'bank:update', bank: crashStore.bank });
          return;
        }
        betRec.cashed = true; betRec.payout = payout; crashStore.bank -= payout; saveCrashStore();
        ws.send(JSON.stringify({ type: 'cashout:ok', clientId, payout })); broadcast({ type: 'bank:update', bank: crashStore.bank });
      }
    });
  });

  // start server
  server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });

  // start rounds
  startNewRound();
  return server;
}

if (require.main === module) {
  // started directly: run server
  startServer();
}

module.exports = { startServer };
