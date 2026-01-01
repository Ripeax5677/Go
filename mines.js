// Mines Game Logic
const minesArea = document.querySelector('.minesArea');
const minesBetSetup = document.getElementById('minesBetSetup');
const minesGame = document.getElementById('minesGame');
const minesBetInput = document.getElementById('minesBet');
const minesBombsInput = document.getElementById('minesBombs');
const startMinesBtn = document.getElementById('startMinesBtn');
const minesBoard = document.getElementById('minesBoard');
const minesSafeCount = document.getElementById('minesSafeCount');
const minesMultiplier = document.getElementById('minesMultiplier');
const minesPayout = document.getElementById('minesPayout');
const minesCashoutBtn = document.getElementById('minesCashoutBtn');
const backFromMinesBtn = document.getElementById('backFromMines');
const verifyMinesBtn = document.getElementById('verifyMinesBtn');

let currentMinesGame = null; // { gameId, bet, bombCount, revealed: Set, multiplier, clientSeed, seedHash }

function generateClientSeed() {
  // Generate a random 64-char hex string
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, byte => byte.toString(16).padStart(2, '0')).join('');
}

function showMines() {
  const startPanel = document.querySelector('.startPanel');
  const gameArea = document.querySelector('.gameArea');
  if (startPanel) startPanel.classList.add('hidden');
  if (gameArea) gameArea.classList.add('hidden');
  if (minesArea) minesArea.classList.remove('hidden');
  if (minesBetSetup) minesBetSetup.classList.remove('hidden');
  if (minesGame) minesGame.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

if (backFromMinesBtn) {
  backFromMinesBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const startPanel = document.querySelector('.startPanel');
    if (startPanel) startPanel.classList.remove('hidden');
    if (minesArea) minesArea.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Start Mines Game
if (startMinesBtn) {
  startMinesBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const bet = Number(minesBetInput.value || 0);
    const bombCount = Number(minesBombsInput.value || 0);
    const minBet = 100000;

    if (bet < minBet) {
      alert(`Minimum bet is ${minBet}`);
      return;
    }
    if (bombCount < 1 || bombCount > 24) {
      alert('Bomb count must be 1-24');
      return;
    }

    // Init game with client seed
    const clientSeed = generateClientSeed();
    currentMinesGame = {
      gameId: null,
      bet,
      bombCount,
      revealed: new Set(),
      multiplier: 1,
      clientSeed,
      seedHash: null,
    };

    // Show board
    if (minesBetSetup) minesBetSetup.classList.add('hidden');
    if (minesGame) minesGame.classList.remove('hidden');

    // Render empty board
    renderMinesBoard();
  });
}

function renderMinesBoard() {
  if (!minesBoard) return;
  minesBoard.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'mineCell';
    cell.textContent = '';
    cell.dataset.index = i;
    cell.addEventListener('click', () => revealMineCell(i));
    minesBoard.appendChild(cell);
  }
}

async function revealMineCell(index) {
  if (!currentMinesGame) return;
  if (currentMinesGame.revealed.has(index)) return; // already revealed

  const headers = { 'Content-Type': 'application/json' };
  if (window.userToken) headers['x-user-token'] = window.userToken;

  try {
    const res = await fetch('/api/mines/play', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bet: currentMinesGame.bet,
        bombCount: currentMinesGame.bombCount,
        revealedIndex: index,
        gameId: currentMinesGame.gameId,
        clientSeed: currentMinesGame.clientSeed,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Game error');
      return;
    }

    const data = await res.json();
    currentMinesGame.gameId = data.gameId;
    currentMinesGame.seedHash = data.seedHash;
    currentMinesGame.serverSeed = data.serverSeed;
    currentMinesGame.board = data.board;
    currentMinesGame.revealed.add(index);

    const cell = document.querySelector(`[data-index="${index}"]`);
    if (!cell) return;

    // Client verifies the cell state from the board received from server
    const serverBoardCell = data.board[index];
    const isBomb = serverBoardCell === 1;

    if (isBomb) {
      // BOMB
      cell.textContent = '💣';
      cell.classList.add('bomb', 'revealed');
      setTimeout(() => {
        alert(`BUST! You hit a bomb. Lost your bet. Game ID: ${currentMinesGame.gameId}`);
        // Show verify button
        if (verifyMinesBtn) {
          verifyMinesBtn.classList.remove('hidden');
          verifyMinesBtn.dataset.gameId = currentMinesGame.gameId;
        }
      }, 500);
    } else {
      // SAFE
      cell.textContent = '💎';
      cell.classList.add('revealed');
      currentMinesGame.multiplier = Number(data.multiplier);
      const safeCount = currentMinesGame.revealed.size;
      if (minesSafeCount) minesSafeCount.textContent = safeCount;
      if (minesMultiplier) minesMultiplier.textContent = data.multiplier + 'x';
      if (minesPayout) minesPayout.textContent = data.potentialPayout;
    }
  } catch (e) {
    console.error('Mine reveal error:', e);
    alert('Error revealing cell');
  }
}

// Cashout
if (minesCashoutBtn) {
  minesCashoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentMinesGame) return;

    const headers = { 'Content-Type': 'application/json' };
    if (window.userToken) headers['x-user-token'] = window.userToken;

    try {
      const res = await fetch('/api/mines/cashout', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          gameId: currentMinesGame.gameId,
          multiplier: currentMinesGame.multiplier,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Cashout error');
        return;
      }

      const data = await res.json();
      alert(`Cashed out! Payout: ${data.payout}`);
      // Update top balance
      const topBalanceEl = document.getElementById('topBalance');
      if (topBalanceEl) topBalanceEl.textContent = data.balance;
      
      // Store game ID for later verification and show verify button
      if (verifyMinesBtn) {
        verifyMinesBtn.classList.remove('hidden');
        verifyMinesBtn.dataset.gameId = currentMinesGame.gameId;
      }
      
      // Don't reset immediately - let user verify first
      // resetMinesGame();
    } catch (e) {
      console.error('Cashout error:', e);
      alert('Cashout failed');
    }
  });
}

function resetMinesGame() {
  currentMinesGame = null;
  if (minesBetSetup) minesBetSetup.classList.remove('hidden');
  if (minesGame) minesGame.classList.add('hidden');
  if (minesSafeCount) minesSafeCount.textContent = '0';
  if (minesMultiplier) minesMultiplier.textContent = '1.00x';
  if (minesPayout) minesPayout.textContent = '0';
}

// Verify Fairness Button
if (verifyMinesBtn) {
  verifyMinesBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const gameId = verifyMinesBtn.dataset.gameId;
    if (gameId) {
      await verifyMinesGame(gameId);
      // After verifying, hide button and reset
      verifyMinesBtn.classList.add('hidden');
      resetMinesGame();
    }
  });
}

// Verify Mines fairness
async function verifyMinesGame(gameId) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.userToken) headers['x-user-token'] = window.userToken;

  try {
    const res = await fetch(`/api/mines/verify/${gameId}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Fairness-Verifikation fehlgeschlagen: ' + (err.error || 'Unbekannter Fehler'));
      return;
    }

    const data = await res.json();

    // Display verification results
    let verifyText = `🎮 Mines Fairness Verifikation\n\n`;
    verifyText += `📊 Spiel Details:\n`;
    verifyText += `• Einsatz: ${data.bet}\n`;
    verifyText += `• Bomben: ${data.bombCount}\n`;
    verifyText += `• Ergebnis: ${data.outcome.toUpperCase()}\n`;
    verifyText += `• Multiplier: ${data.multiplier}\n`;
    verifyText += `• Payout: ${data.payout}\n\n`;

    verifyText += `🔐 Seed Verifikation:\n`;
    verifyText += `• Server Seed: ${data.serverSeed.slice(0, 16)}...\n`;
    verifyText += `• Client Seed: ${data.clientSeed.slice(0, 16)}...\n`;
    verifyText += `• Seed Hash: ${data.seedHash.slice(0, 16)}...\n\n`;

    verifyText += `✅ Board Match: ${data.verification.boardReconstructed ? 'JA ✓' : 'NEIN ✗'}\n`;
    verifyText += `✅ Seed Hash Match: ${data.verification.seedHashVerified ? 'JA ✓' : 'NEIN ✗'}\n`;
    verifyText += `✅ Board Valid: ${data.verification.boardValid ? 'JA - FAIR! ✓' : 'NEIN ✗'}\n\n`;

    verifyText += `📍 Spielzüge: ${data.moves.join(', ')}\n`;
    verifyText += `🎯 Board Layout:\n`;
    
    // Show board as grid
    let boardStr = '';
    for (let i = 0; i < 25; i++) {
      if (i % 5 === 0 && i > 0) boardStr += '\n';
      boardStr += (data.board[i] === 1 ? '💣' : '💎') + ' ';
    }
    verifyText += boardStr + '\n';

    alert(verifyText);
  } catch (e) {
    console.error('Verify error:', e);
    alert('Fairness-Verifikation fehlgeschlagen: ' + e.message);
  }
}

// Export
window.showMines = showMines;
window.verifyMinesGame = verifyMinesGame;
