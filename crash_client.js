(() => {
  const wsProtocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(`${wsProtocol}${location.host}`);

  const elements = {
    bank: document.getElementById('crashBank'),
    multiplier: document.getElementById('crashMultiplier'),
    runBar: document.getElementById('crashRunBar'),
    placeBet: document.getElementById('crashPlaceBet'),
    betAmount: document.getElementById('crashBetAmount'),
    cashout: document.getElementById('crashCashout'),
    verify: document.getElementById('crashVerify'),
    roundId: document.getElementById('crashRound'),
    possible: document.getElementById('crashPossible'),
    minBet: document.getElementById('crashMinBet'),
    status: document.getElementById('status'),
    countdown: document.getElementById('crashCountdown'),
    progress: document.getElementById('crashProgress'),
    history: document.getElementById('crashHistoryList'),
    modal: document.getElementById('crashModal'),
    modalClose: document.getElementById('crashModalClose'),
    modalContent: document.getElementById('crashModalContent'),
  };

  const state = {
    clientId: localStorage.getItem('crashClientId') || Math.random().toString(36).slice(2),
    currentRound: null,
    hasBet: false,
    running: false,
    bettingActive: false,
    minBet: 0,
    bettingTimer: null,
  };

  localStorage.setItem('crashClientId', state.clientId);

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'info') {
      if (elements.bank) elements.bank.textContent = data.bank;
      renderHistory(data.history || []);
      return;
    }

    if (data.type === 'round:start') {
      state.currentRound = data.id;
      state.hasBet = false;
      state.running = false;
      state.minBet = Number(data.minBet || 0);

      if (elements.roundId) elements.roundId.textContent = data.id;
      if (elements.multiplier) {
        elements.multiplier.textContent = '1.00x';
        elements.multiplier.style.transform = '';
      }
      if (elements.possible) elements.possible.textContent = '0';
      if (elements.cashout) elements.cashout.disabled = true;
      if (elements.runBar) elements.runBar.style.width = '0%';
      if (elements.minBet) elements.minBet.textContent = state.minBet > 0 ? String(state.minBet) : '-';
      if (elements.verify) {
        elements.verify.disabled = false;
        elements.verify.onclick = () => openCrashModal(data.id);
      }

      setStatus('Betting...');
      startBettingCountdown(data.bettingEnds || Date.now() + 20000);
      return;
    }

    if (data.type === 'round:run') {
      state.running = true;
      setStatus('Running');
      if (elements.runBar) elements.runBar.style.width = '0%';
      return;
    }

    if (data.type === 'round:tick') {
      const multiplier = Number(data.multiplier || 1);
      if (elements.multiplier) elements.multiplier.textContent = `${multiplier.toFixed(2)}x`;

      if (state.hasBet && elements.betAmount) {
        const bet = Number(elements.betAmount.value || 0);
        if (elements.cashout) elements.cashout.disabled = false;
        if (elements.possible) elements.possible.textContent = (bet * multiplier).toFixed(2);
      }

      if (state.running && elements.runBar) {
        const pct = Math.min(100, Math.max(0, (1 - 1 / multiplier) * 100));
        elements.runBar.style.width = `${pct}%`;
      }

      if (state.running && elements.multiplier) {
        const scale = Math.min(1.6, 1 + (multiplier - 1) * 0.06);
        elements.multiplier.style.transform = `scale(${scale})`;
      }
      return;
    }

    if (data.type === 'round:crash') {
      state.hasBet = false;
      state.running = false;

      if (elements.multiplier) {
        elements.multiplier.textContent = `${Number(data.crashMultiplier).toFixed(2)}x (CRASH)`;
        elements.multiplier.style.transform = '';
      }
      if (elements.cashout) elements.cashout.disabled = true;
      if (elements.runBar) elements.runBar.style.width = '100%';
      setStatus('Crashed');
      renderHistory([{ id: data.id, crashMultiplier: data.crashMultiplier }]);
      return;
    }

    if (data.type === 'bet:accepted') {
      state.hasBet = true;
      if (elements.cashout) elements.cashout.disabled = true;
      setStatus('Bet placed');
      return;
    }

    if (data.type === 'cashout:ok') {
      alert(`Cashed out: ${data.payout}`);
      setStatus('Cashed out');
      return;
    }

    if (data.type === 'bank:update' && elements.bank) {
      elements.bank.textContent = data.bank;
    }
  });

  if (elements.placeBet) {
    elements.placeBet.addEventListener('click', () => {
      if (!state.currentRound) return alert('No round');

      const amount = Number(elements.betAmount && elements.betAmount.value) || 0;
      if (amount <= 0) return alert('Invalid bet');
      if (!state.bettingActive) return alert('Betting closed');
      if (state.minBet > 0 && amount < state.minBet) return alert(`Minimum bet is ${state.minBet}`);

      ws.send(JSON.stringify({
        type: 'placeBet',
        clientId: state.clientId,
        amount,
        roundId: state.currentRound,
      }));
    });
  }

  if (elements.cashout) {
    elements.cashout.addEventListener('click', () => {
      if (!state.currentRound) return;
      ws.send(JSON.stringify({
        type: 'cashout',
        clientId: state.clientId,
        roundId: state.currentRound,
      }));
    });
  }

  const presetButtons = document.querySelectorAll('.presetBtn');
  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!elements.betAmount) return;
      const amount = button.getAttribute('data-amt');
      if (amount === 'max') {
        const bank = Number(elements.bank && elements.bank.textContent) || 0;
        elements.betAmount.value = String(bank || state.minBet || 0);
        return;
      }
      const numericValue = Number(amount);
      if (!Number.isNaN(numericValue)) elements.betAmount.value = String(numericValue);
    });
  });

  if (elements.modalClose) {
    elements.modalClose.addEventListener('click', () => {
      if (elements.modal) elements.modal.classList.add('hidden');
    });
  }

  function setStatus(text) {
    if (elements.status) elements.status.textContent = `Status: ${text}`;
  }

  function renderHistory(rounds) {
    if (!elements.history) return;

    elements.history.innerHTML = '';
    rounds.slice(0, 10).forEach((round) => {
      const item = document.createElement('li');
      item.textContent = `${round.id.slice(0, 6)} — ${round.crashMultiplier}x`;
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => openCrashModal(round.id));
      elements.history.appendChild(item);
    });
  }

  function startBettingCountdown(bettingEndsAt) {
    clearInterval(state.bettingTimer);
    state.bettingActive = true;

    const bettingWindowMs = 20000;
    const bettingStartsAt = bettingEndsAt - bettingWindowMs;

    const tick = () => {
      const now = Date.now();
      const remainingSeconds = Math.max(0, Math.ceil((bettingEndsAt - now) / 1000));
      if (elements.countdown) elements.countdown.textContent = String(remainingSeconds);

      const elapsed = Math.max(0, now - bettingStartsAt);
      const pct = Math.min(100, Math.floor((elapsed / bettingWindowMs) * 100));
      if (elements.progress) elements.progress.style.width = `${pct}%`;

      if (now >= bettingEndsAt) {
        state.bettingActive = false;
        clearInterval(state.bettingTimer);
        if (elements.countdown) elements.countdown.textContent = '0';
        if (elements.progress) elements.progress.style.width = '100%';
      }
    };

    tick();
    state.bettingTimer = setInterval(tick, 200);
  }

  async function openCrashModal(roundId) {
    if (!elements.modal || !elements.modalContent) {
      window.open(`/crash/verify/${roundId}`);
      return;
    }

    elements.modal.classList.remove('hidden');
    elements.modalContent.textContent = 'Loading…';

    try {
      const response = await fetch(`/crash/verify/${roundId}`);
      if (!response.ok) throw new Error('Round not found');
      const proof = await response.json();

      const computed = await computeCrashFromSeed(proof.serverSeed);
      const matches = computed === proof.crashMultiplier;

      elements.modalContent.innerHTML = `
        <p><strong>Round:</strong> ${proof.id}</p>
        <p><strong>Seed Hash:</strong> ${proof.seedHash}</p>
        <p><strong>Server Seed:</strong> <code>${proof.serverSeed}</code></p>
        <p><strong>Server Multiplier:</strong> ${proof.crashMultiplier}x</p>
        <p><strong>Computed Multiplier:</strong> ${computed}x ${matches ? '✅' : '❌'}</p>
      `;
    } catch (error) {
      elements.modalContent.textContent = 'Error loading proof';
    }
  }

  async function computeCrashFromSeed(serverSeed) {
    const key = hexToBytes(serverSeed);
    const message = new TextEncoder().encode('crash');
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, message);
    const hex = bytesToHex(new Uint8Array(signature));

    const value = parseInt(hex.slice(0, 13), 16) / Math.pow(2, 52);
    const raw = Math.max(1.0, Math.floor((1 / (1 - value)) * 100) / 100);
    const withHouseEdge = Math.max(1.0, Math.floor(raw * 0.97 * 100) / 100);
    return Math.min(withHouseEdge, 10000);
  }

  function hexToBytes(hex) {
    if (!hex) return new Uint8Array();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
})();
