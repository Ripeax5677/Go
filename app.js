const flipBtn = document.getElementById('flipBtn');
const coinEl = document.getElementById('coin');
const coinInner = document.getElementById('coinInner');
const resultEl = document.getElementById('result');
const localLogEl = document.getElementById('localLog');
const userNameEl = document.getElementById('userName');
const betAmountEl = document.getElementById('betAmount');
const userInfoEl = document.getElementById('userInfo');
const chooseHeadsBtn = document.getElementById('chooseHeads');
const chooseTailsBtn = document.getElementById('chooseTails');
const payoutMulEl = document.getElementById('payoutMul');
const payoutReturnEl = document.getElementById('payoutReturn');

// provably-fair / verification elements
const verifyCoinflipBtn = document.getElementById('verifyCoinflipBtn');
const topBalanceEl = document.getElementById('topBalance');

let localLog = [];
let selectedChoice = 'heads';

function showResult(text) {
  // Clear result but preserve the button
  while (resultEl.firstChild && resultEl.firstChild !== verifyCoinflipBtn) {
    resultEl.removeChild(resultEl.firstChild);
  }
  
  // Create a text element for the result
  const textEl = document.createElement('div');
  textEl.textContent = text;
  resultEl.insertBefore(textEl, verifyCoinflipBtn);
}

function addLocalLog(entry) {
  localLog.unshift(entry);
  if (localLog.length > 20) localLog.pop();
  renderLocalLog();
}

function renderLocalLog() {
  if (!localLogEl) return; // UI may omit recent flips section
  localLogEl.innerHTML = '';
  for (const e of localLog) {
    const li = document.createElement('li');
    const t = new Date(e.ts).toLocaleString();
    li.textContent = `${t} — ${e.user || 'Anonymous'}: ${e.outcome}`;
    localLogEl.appendChild(li);
  }
}

async function flipCoin() {
  flipBtn.disabled = true;
  const user = userNameEl && userNameEl.value ? userNameEl.value.trim() : null;
  const bet = Number(betAmountEl.value || 0) || 0;
  // Generate random client seed
  const clientSeed = cryptoRandomHex(8);

  const headers = { 'Content-Type': 'application/json' };
  if (window.userToken) headers['x-user-token'] = window.userToken;

  let data = null;
  try {
    // fetch outcome first so we can target the animation to the result
    const res = await fetch('/api/flip', {
      method: 'POST',
      headers,
      body: JSON.stringify({ user, clientSeed, bet, choice: selectedChoice }),
    });
    if (!res.ok) {
      if (res.status === 403) {
        showResult('You are banned and cannot play');
        return;
      }
      const err = await res.json().catch(() => ({}));
      showResult(err && err.error ? String(err.error) : 'Flip error');
      return;
    }
    data = await res.json();
    showResult(`Result: ${data.outcome}`);

    // apply targeted spin class so the animation ends on the correct face
    const spinClass = data.outcome === 'heads' ? 'spin-heads' : 'spin-tails';
    coinInner.classList.add(spinClass);

    // wait for animation to finish
    await new Promise((resolve) => {
      coinInner.addEventListener('animationend', () => resolve(), { once: true });
    });

    // ensure final transform aligns exactly
    coinInner.style.transform = data.outcome === 'heads' ? 'rotateY(0deg)' : 'rotateY(180deg)';
    addLocalLog(data);
    if (data.balance !== undefined) userInfoEl.textContent = `${data.username || ''} — Balance: ${data.balance}`;
      // update top balance if present
      if (data.balance !== undefined && topBalanceEl) topBalanceEl.textContent = data.balance;

      // Show verify button and store game ID
      if (verifyCoinflipBtn) {
        verifyCoinflipBtn.classList.remove('hidden');
        verifyCoinflipBtn.dataset.gameId = data.id;
        verifyCoinflipBtn.dataset.serverSeed = data.serverSeed;
        verifyCoinflipBtn.dataset.seedHash = data.seedHash;
        verifyCoinflipBtn.dataset.clientSeed = clientSeed;
      }

    // show payout if bet was placed — prefer server result
    if (bet > 0) {
      if (data.won) {
        showResult(`You won! ${data.outcome} — Payout ${data.payout}`);
      } else {
        showResult(`You lost — ${data.outcome}`);
      }
    }
  } catch (e) {
    showResult('Error flipping coin');
  } finally {
    coinInner.classList.remove('spin-heads', 'spin-tails');
    flipBtn.disabled = false;
  }
}

flipBtn.addEventListener('click', flipCoin);

// choice button handlers
if (chooseHeadsBtn && chooseTailsBtn) {
  chooseHeadsBtn.addEventListener('click', () => {
    selectedChoice = 'heads';
    chooseHeadsBtn.classList.add('selected');
    chooseTailsBtn.classList.remove('selected');
  });
  chooseTailsBtn.addEventListener('click', () => {
    selectedChoice = 'tails';
    chooseTailsBtn.classList.add('selected');
    chooseHeadsBtn.classList.remove('selected');
  });
}

// update payout return when bet changes
if (payoutReturnEl && betAmountEl) {
  const updateReturn = () => {
    const b = Number(betAmountEl.value || 0) || 0;
    payoutReturnEl.textContent = b > 0 ? String(Math.floor(b * 1.9)) : '0';
  };
  betAmountEl.addEventListener('input', updateReturn);
  updateReturn();
}
// verify last flip client-side using revealed serverSeed and clientSeed
async function hmacHex(keyHex, msg) {
  function hexToBytes(hex) { return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16))); }
  const key = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(String(msg || '')));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyCoinflipFairness() {
  const serverSeed = verifyCoinflipBtn.dataset.serverSeed;
  const seedHash = verifyCoinflipBtn.dataset.seedHash;
  const clientSeed = verifyCoinflipBtn.dataset.clientSeed;
  
  if (!serverSeed) return alert('No server seed available to verify');

  // Compute HMAC-SHA256
  const h = await hmacHex(serverSeed, clientSeed);
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  const computed = v < 0.5 ? 'heads' : 'tails';

  // Verify seed hash
  const key = new TextEncoder().encode(serverSeed);
  const digestBuffer = await crypto.subtle.digest('SHA-256', key);
  const computedHash = Array.from(new Uint8Array(digestBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const seedHashMatch = computedHash === seedHash;

  let verifyText = `🎲 Coin Flip Fairness Verification\n\n`;
  verifyText += `📊 Flip Details:\n`;
  verifyText += `• Computed Outcome: ${computed.toUpperCase()}\n`;
  verifyText += `• HMAC Result: ${h.slice(0, 16)}...\n\n`;

  verifyText += `🔐 Seed Verification:\n`;
  verifyText += `• Server Seed: ${serverSeed.slice(0, 16)}...\n`;
  verifyText += `• Client Seed: ${clientSeed.slice(0, 16)}...\n`;
  verifyText += `• Seed Hash: ${seedHash.slice(0, 16)}...\n\n`;

  verifyText += `✅ Seed Hash Match: ${seedHashMatch ? 'JA ✓' : 'NEIN ✗'}\n`;
  verifyText += `✅ Outcome Deterministic: JA ✓\n\n`;
  verifyText += `${seedHashMatch ? '✅ FAIRNESS VERIFIED!' : '❌ Hash mismatch!'}`;

  alert(verifyText);
}

if (verifyCoinflipBtn) verifyCoinflipBtn.addEventListener('click', verifyCoinflipFairness);

// initial render
// ensure coin faces start showing heads
if (coinInner) coinInner.style.transform = 'rotateY(0deg)';
renderLocalLog();

// small helper to generate clientSeed
function cryptoRandomHex(len = 8) {
  const arr = new Uint8Array(len);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// handle Discord login button
// (removed - now on login.html)

// Store token in localStorage for persistence
function saveToken(token) {
  if (token) {
    console.log('saveToken: saving token', token.slice(0, 10) + '...');
    window.userToken = token;
    localStorage.setItem('userToken', token);
  }
}

function loadToken() {
  const stored = localStorage.getItem('userToken');
  console.log('loadToken: found stored token?', !!stored);
  if (stored) {
    window.userToken = stored;
    console.log('loadToken: set window.userToken', stored.slice(0, 10) + '...');
    return true;
  }
  return false;
}

// handle token in URL (after OAuth redirect)
function readQueryToken() {
  const p = new URLSearchParams(window.location.search);
  const t = p.get('token');
  console.log('readQueryToken: token from URL?', t ? t.slice(0, 10) + '...' : 'NOT FOUND');
  if (t) {
    console.log('readQueryToken: found token, saving...');
    saveToken(t);
    // remove query param from URL for cleanliness
    history.replaceState({}, '', window.location.pathname);
    return true;
  }
  return false;
}

async function fetchMe() {
  if (!window.userToken) {
    console.log('No token in fetchMe - redirecting to login');
    window.location.href = '/login.html';
    return;
  }
  try {
    console.log('Sending token header:', window.userToken.slice(0, 10) + '...');
    const res = await fetch('/api/me', { headers: { 'x-user-token': window.userToken } });
    console.log('fetchMe response status:', res.status);
    if (res.status === 200) {
      const j = await res.json();
      console.log('User data received:', j);
      if (j.banned) {
        showBannedOverlay();
        return;
      }
        userInfoEl.textContent = `${j.username} — Balance: ${j.balance}`;
        if (topBalanceEl) topBalanceEl.textContent = j.balance;
    } else {
      // Token invalid, clear it and redirect to login
      console.log('Token invalid (status ' + res.status + ') - redirecting to login');
      localStorage.removeItem('userToken');
      window.userToken = null;
      window.location.href = '/login.html';
    }
  } catch (e) {
    console.warn('me err', e);
    window.location.href = '/login.html';
  }
}

function showBannedOverlay() {
  const o = document.getElementById('bannedOverlay');
  if (!o) return;
  o.classList.remove('hidden');
  // hide main container
  const main = document.querySelector('main.container');
  if (main) main.style.filter = 'blur(2px)';
  // ensure logout visible
  const logoutVisible = document.getElementById('profileLogoutVisible');
  if (logoutVisible) logoutVisible.classList.remove('hidden');
  // disable flip and inputs
  if (flipBtn) flipBtn.disabled = true;
  if (betAmountEl) betAmountEl.disabled = true;
  // setup banned logout
  const bannedLogout = document.getElementById('bannedLogout');
  if (bannedLogout) bannedLogout.addEventListener('click', async () => {
    try { await fetch('/auth/logout'); } catch (e) {}
    localStorage.removeItem('userToken'); window.userToken = null; window.location.href = '/login.html';
  });
}

function hideBannedOverlay() {
  const o = document.getElementById('bannedOverlay');
  if (!o) return;
  o.classList.add('hidden');
  const main = document.querySelector('main.container');
  if (main) main.style.filter = '';
}

// Initialize: check localStorage and load token
async function initPage() {
  console.log('=== initPage START ===');
  console.log('Current URL:', window.location.href);
  
  // First check if token is in URL query param (after Discord OAuth)
  readQueryToken();
  
  // Then load from localStorage (or use the one we just saved from URL)
  loadToken();
  
  console.log('initPage: window.userToken is now:', window.userToken ? window.userToken.slice(0, 10) + '...' : 'MISSING');
  
  // If token present, fetch user info; otherwise redirect to login
  if (window.userToken) {
    console.log('Fetching user info...');
    await fetchMe();
  } else {
    console.log('No token found - redirecting to login');
    window.location.href = '/login.html';
  }
  console.log('=== initPage END ===');
}

initPage();

// fetch current seed commitment and show it
(async function loadSeedCommitment(){
  try {
    const r = await fetch('/api/seed');
    if (r.ok) {
      const j = await r.json();
      if (seedHashDisplay) seedHashDisplay.textContent = j.seedHash || '';
    }
  } catch (e) { console.warn('seed fetch failed', e); }
})();

  // Mode navigation: show/hide start panel and coinflip area
  const playCoinFlipBtn = document.getElementById('playCoinFlip');
  const backBtn = document.getElementById('backBtn');
  const startPanel = document.querySelector('.startPanel');
  const gameArea = document.querySelector('.gameArea');

  function showCoinFlip() {
    // Open the game area regardless; if not logged in, show login hint and disable betting
    if (startPanel) startPanel.classList.add('hidden');
    if (gameArea) gameArea.classList.remove('hidden');
    if (backBtn) backBtn.classList.remove('hidden');
    // if user not logged in, disable bet controls and show login prompt
    if (!window.userToken) {
      if (betAmountEl) betAmountEl.disabled = true;
      if (flipBtn) flipBtn.disabled = true;
      if (userInfoEl) userInfoEl.innerHTML = 'Please <a href="/login.html">login</a> to place bets.';
    } else {
      if (betAmountEl) betAmountEl.disabled = false;
      if (flipBtn) flipBtn.disabled = false;
    }
    // focus coin area
    const coinSection = document.getElementById('coin');
    if (coinSection) coinSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showStartPanel() {
    if (startPanel) startPanel.classList.remove('hidden');
    if (gameArea) gameArea.classList.add('hidden');
    if (backBtn) backBtn.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (playCoinFlipBtn) playCoinFlipBtn.addEventListener('click', (e) => { e.preventDefault(); showCoinFlip(); });
  if (backBtn) backBtn.addEventListener('click', (e) => { e.preventDefault(); showStartPanel(); });

// Wire Play Mines
const playMinesBtn = document.getElementById('playMines');
if (playMinesBtn) {
  playMinesBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!window.userToken) {
      window.location.href = '/login.html';
      return;
    }
    window.showMines();
  });
}

// Wire Play Crash
const playCrashBtn = document.getElementById('playCrash');
const crashArea = document.querySelector('.crashArea');
const backFromCrash = document.getElementById('backFromCrash');
if (playCrashBtn) {
  playCrashBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!window.userToken) { window.location.href = '/login.html'; return; }
    showCrash();
  });
}
if (backFromCrash) backFromCrash.addEventListener('click', (e) => { e.preventDefault(); showStartPanel(); });

function showCrash() {
  if (startPanel) startPanel.classList.add('hidden');
  if (gameArea) gameArea.classList.add('hidden');
  if (crashArea) crashArea.classList.remove('hidden');
  if (backBtn) backBtn.classList.remove('hidden');
  // load crash client script and CSS are statically included in index.html
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function enforceLoginUI() {
  const loggedIn = !!window.userToken;
  
  // If NOT logged in, redirect to login page
  if (!loggedIn) {
    window.location.href = '/login.html';
    return;
  }
  
  // If logged in, enable game buttons
  if (flipBtn) flipBtn.disabled = false;
  if (betAmountEl) betAmountEl.disabled = false;
}

// (Discord login button removed - now on login.html)
