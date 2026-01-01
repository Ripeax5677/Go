(function(){
  // WebSocket to crash server on same host/port
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const wsHost = location.host; // includes port when present
  const ws = new WebSocket(wsProto + wsHost);

  const bankEl = document.getElementById('crashBank');
  const multiplierEl = document.getElementById('crashMultiplier');
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

  ws.addEventListener('open', () => console.log('crash ws connected', ws.url));
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'info'){
      bankEl.textContent = d.bank;
      renderHistory(d.history || []);
    }
    if (d.type === 'round:start'){
      currentRound = d.id; roundEl.textContent = d.id; multiplierEl.textContent = '1.00x';
      verifyBtn.disabled = false; verifyBtn.onclick = () => window.open('/crash/verify/' + d.id);
      hasBet = false; cashoutBtn.disabled = true; possibleEl.textContent = '0';
      statusText('Betting...');
      // start betting countdown
      startBettingCountdown(d.bettingEnds || (Date.now()+20000));
    }
    if (d.type === 'round:run'){
      statusText('Running');
    }
    if (d.type === 'round:tick'){
      multiplierEl.textContent = d.multiplier.toFixed(2) + 'x';
      if (hasBet) { cashoutBtn.disabled = false; possibleEl.textContent = (Number(betInput.value||0)*d.multiplier).toFixed(2); }
    }
    if (d.type === 'round:crash'){
      multiplierEl.textContent = d.crashMultiplier.toFixed(2) + 'x (CRASH)'; cashoutBtn.disabled = true; hasBet = false;
      statusText('Crashed');
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
    ws.send(JSON.stringify({ type: 'placeBet', clientId, amount: amt, roundId: currentRound }));
  });
  cashoutBtn && cashoutBtn.addEventListener('click', () => { if (!currentRound) return; ws.send(JSON.stringify({ type: 'cashout', clientId, roundId: currentRound })); });

  function renderHistory(h){ if(!historyList) return; historyList.innerHTML=''; (h||[]).slice(0,10).forEach(r=>{ const li=document.createElement('li'); li.textContent = `${r.id.slice(0,6)} — ${r.crashMultiplier}x`; historyList.appendChild(li); }); }
  
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
})();
