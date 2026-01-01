(function(){
  // WebSocket to crash server on same host/port
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const wsHost = location.host; // includes port when present
  const ws = new WebSocket(wsProto + wsHost);

  const bankEl = document.getElementById('crashBank');
  const multiplierEl = document.getElementById('crashMultiplier');
  const runBar = document.getElementById('crashRunBar');
  const placeBtn = document.getElementById('crashPlaceBet');
  const betInput = document.getElementById('crashBetAmount');
  const cashoutBtn = document.getElementById('crashCashout');
  const verifyBtn = document.getElementById('crashVerify');
  const roundEl = document.getElementById('crashRound');
  const possibleEl = document.getElementById('crashPossible');
  const historyList = document.getElementById('crashHistoryList');

  let clientId = localStorage.getItem('crashClientId');
  if(!clientId){ clientId = Math.random().toString(36).slice(2); localStorage.setItem('crashClientId', clientId); }
  let currentRound = null;
  let hasBet = false;
  let running = false;
  let minBet = 0;

  ws.addEventListener('open', () => console.log('crash ws connected', ws.url));
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'info'){
      bankEl.textContent = d.bank;
      renderHistory(d.history || []);
    }
    if (d.type === 'round:start'){
      currentRound = d.id; roundEl.textContent = d.id; multiplierEl.textContent = '1.00x';
      verifyBtn.disabled = false; verifyBtn.dataset.roundId = d.id; verifyBtn.onclick = () => openCrashModal(verifyBtn.dataset.roundId || currentRound);
      hasBet = false; cashoutBtn.disabled = true; possibleEl.textContent = '0'; running = false; if(runBar) runBar.style.width = '0%'; multiplierEl.style.transform = '';
      statusText('Betting...');
      // start betting countdown
      startBettingCountdown(d.bettingEnds || (Date.now()+20000));
      // read and show minBet if provided
      minBet = Number(d.minBet || 0);
      const minEl = document.getElementById('crashMinBet'); if (minEl) minEl.textContent = minBet > 0 ? String(minBet) : '-';
    }
    if (d.type === 'round:run'){
      statusText('Running'); running = true; if(runBar) runBar.style.width = '0%';
    }
    if (d.type === 'round:tick'){
      multiplierEl.textContent = d.multiplier.toFixed(2) + 'x';
      if (hasBet) { cashoutBtn.disabled = false; possibleEl.textContent = (Number(betInput.value||0)*d.multiplier).toFixed(2); }
      // running visual: map multiplier to a progress percentage so it accelerates as multiplier grows
      if (running && runBar) {
        const m = Number(d.multiplier) || 1;
        const pct = Math.min(100, Math.max(0, (1 - 1 / m) * 100));
        runBar.style.width = pct + '%';
        const scale = Math.min(1.6, 1 + (m - 1) * 0.06);
        multiplierEl.style.transform = `scale(${scale})`;
      }
    }
    if (d.type === 'round:crash'){
      multiplierEl.textContent = d.crashMultiplier.toFixed(2) + 'x (CRASH)'; cashoutBtn.disabled = true; hasBet = false; running = false;
      statusText('Crashed');
      if(runBar) runBar.style.width = '100%'; multiplierEl.style.transform = '';
      renderHistory([{ id: d.id, crashMultiplier: d.crashMultiplier }].concat([]));
    }
    if (d.type === 'bet:accepted'){
      hasBet = true; cashoutBtn.disabled = true; statusText('Bet placed');
    }
    if (d.type === 'cashout:ok'){
      alert('Cashed out: ' + d.payout);
      statusText('Cashed out');
    }
    if (d.type === 'bank:update') bankEl.textContent = d.bank;
  });

  function statusText(t){ const s = document.getElementById('status'); if(s) s.textContent = 'Status: ' + t; }

  placeBtn && placeBtn.addEventListener('click', () => {
    if (!currentRound) return alert('No round');
    const amt = Number(betInput.value) || 0; if (amt <= 0) return alert('Invalid bet');
    // ensure still in betting phase
    if (bettingActive === false) return alert('Betting closed');
    if (minBet > 0 && amt < minBet) return alert('Minimum bet is ' + minBet);
    ws.send(JSON.stringify({ type: 'placeBet', clientId, amount: amt, roundId: currentRound }));
  });
  cashoutBtn && cashoutBtn.addEventListener('click', () => { if (!currentRound) return; ws.send(JSON.stringify({ type: 'cashout', clientId, roundId: currentRound })); });

  function renderHistory(h){ if(!historyList) return; historyList.innerHTML=''; (h||[]).slice(0,10).forEach(r=>{ const li=document.createElement('li'); li.textContent = `${r.id.slice(0,6)} — ${r.crashMultiplier}x`; historyList.appendChild(li); }); }

  // make history items clickable to open proof modal for that round
  function renderHistory(h){ if(!historyList) return; historyList.innerHTML=''; (h||[]).slice(0,10).forEach(r=>{ const li=document.createElement('li'); li.textContent = `${r.id.slice(0,6)} — ${r.crashMultiplier}x`; li.style.cursor='pointer'; li.addEventListener('click', () => openCrashModal(r.id)); historyList.appendChild(li); }); }
  
  // Betting countdown and progress
  let bettingTimer = null;
  let bettingActive = false;
  function startBettingCountdown(bettingEnds){
    clearInterval(bettingTimer);
    bettingActive = true;
    const countdownEl = document.getElementById('crashCountdown');
    const progressEl = document.getElementById('crashProgress');
    function tick(){
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((bettingEnds - now) / 1000));
      if (countdownEl) countdownEl.textContent = String(remaining);
      const total = Math.max(1, (bettingEnds - (bettingEnds - 20000)) || 20000);
      const elapsed = Math.max(0, (now - (bettingEnds - 20000)));
      const pct = Math.min(100, Math.floor((elapsed / total) * 100));
      if (progressEl) progressEl.style.width = pct + '%';
      if (now >= bettingEnds){
        bettingActive = false; clearInterval(bettingTimer); if (countdownEl) countdownEl.textContent = '0'; if (progressEl) progressEl.style.width = '100%';
      }
    }
    tick();
    bettingTimer = setInterval(tick, 200);
  }

  // Preset buttons handlers
  const presetBtns = document.querySelectorAll('.presetBtn');
  function setBetAmount(v){ if (!betInput) return; betInput.value = String(v); }
  presetBtns.forEach(b => b.addEventListener('click', (e) => {
    const v = b.getAttribute('data-amt');
    if (v === 'max') {
      // set to bank if available
      const bank = Number((document.getElementById('crashBank')||{}).textContent) || 0;
      setBetAmount(bank || (minBet || 0));
      return;
    }
    const n = Number(v);
    if (!isNaN(n)) setBetAmount(n);
  }));

  // --- Crash modal & verification helpers
  const crashModal = document.getElementById('crashModal');
  const crashModalClose = document.getElementById('crashModalClose');
  const crashModalContent = document.getElementById('crashModalContent');
  if (crashModalClose) crashModalClose.addEventListener('click', () => { if (crashModal) crashModal.classList.add('hidden'); });

  async function openCrashModal(roundId){
    if (!crashModal || !crashModalContent) return window.open('/crash/verify/' + roundId);
    crashModal.classList.remove('hidden');
    crashModalContent.textContent = 'Loading…';
    try {
      const res = await fetch('/crash/verify/' + roundId);
      if (!res.ok) throw new Error('not found');
      const body = await res.json();
      // compute HMAC and crash multiplier locally to verify
      const computed = await computeCrashFromSeed(body.serverSeed);
      const ok = computed === body.crashMultiplier;
      crashModalContent.innerHTML = `
        <p><strong>Round:</strong> ${body.id}</p>
        <p><strong>Seed Hash:</strong> ${body.seedHash}</p>
        <p><strong>Server Seed:</strong> <code>${body.serverSeed}</code></p>
        <p><strong>Server Multiplier:</strong> ${body.crashMultiplier}x</p>
        <p><strong>Computed Multiplier:</strong> ${computed}x ${ok ? '✅' : '❌'}</p>
      `;
    } catch (e) {
      crashModalContent.textContent = 'Error loading proof';
    }
  }

  async function computeCrashFromSeed(serverSeed){
    // HMAC-SHA256(serverSeed, 'crash') -> hex
    const key = hexToBytes(serverSeed);
    const msg = new TextEncoder().encode('crash');
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msg);
    const h = bytesToHex(new Uint8Array(sig));
    const v = parseInt(h.slice(0,13), 16) / Math.pow(2, 52);
    const raw = Math.max(1.0, Math.floor((1 / (1 - v)) * 100) / 100);
    const withEdge = Math.max(1.0, Math.floor(raw * 0.97 * 100) / 100);
    return Math.min(withEdge, 10000);
  }

  function hexToBytes(hex){ if (!hex) return new Uint8Array(); const a = new Uint8Array(hex.length/2); for (let i=0;i<a.length;i++) a[i]=parseInt(hex.substr(i*2,2),16); return a; }
  function bytesToHex(bytes){ return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join(''); }

})();
