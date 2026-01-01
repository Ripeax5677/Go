(() => {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + (location.port ? ':' + (location.port === '3000' ? '3001' : location.port) : ':3001');
  const ws = new WebSocket(wsUrl);
  const bankEl = document.getElementById('bank');
  const multiplierEl = document.getElementById('multiplier');
  const placeBtn = document.getElementById('placeBet');
  const betAmount = document.getElementById('betAmount');
  const cashoutBtn = document.getElementById('cashout');
  const statusEl = document.getElementById('status');
  const roundIdEl = document.getElementById('roundId');
  const verifyBtn = document.getElementById('verifyFair');
  const possibleEl = document.getElementById('possible');
  const historyList = document.getElementById('historyList');

  // client id
  let clientId = localStorage.getItem('crashClientId');
  if(!clientId){ clientId = Math.random().toString(36).slice(2); localStorage.setItem('crashClientId', clientId); }

  let currentRound = null;
  let hasBet = false;

  ws.addEventListener('open', () => console.log('ws open', wsUrl));
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'info'){
      bankEl.textContent = d.bank;
      renderHistory(d.history);
    }
    if (d.type === 'round:start'){
      currentRound = d.id;
      roundIdEl.textContent = d.id;
      statusEl.textContent = 'Betting...';
      multiplierEl.textContent = '1.00x';
      verifyBtn.disabled = false;
      verifyBtn.onclick = () => { window.open('/crash/verify/' + d.id); };
      hasBet = false; cashoutBtn.disabled = true;
    }
    if (d.type === 'round:run'){
      statusEl.textContent = 'Running';
    }
    if (d.type === 'round:tick'){
      multiplierEl.textContent = d.multiplier.toFixed(2) + 'x';
      if (hasBet) cashoutBtn.disabled = false;
      possibleEl.textContent = hasBet ? (Number(betAmount.value||0)*parseFloat(d.multiplier)).toFixed(2) : '0';
    }
    if (d.type === 'round:crash'){
      multiplierEl.textContent = d.crashMultiplier.toFixed(2) + 'x (CRASH)';
      statusEl.textContent = 'Crashed';
      cashoutBtn.disabled = true;
    }
    if (d.type === 'bet:accepted'){ console.log('bet accepted', d); }
    if (d.type === 'cashout:ok'){ alert('CASHED OUT: ' + d.payout); }
    if (d.type === 'bank:update') { bankEl.textContent = d.bank; }
  });

  placeBtn.addEventListener('click', () => {
    if (!currentRound) return alert('No round open');
    const amt = Number(betAmount.value) || 0;
    if (amt <= 0) return alert('Invalid bet');
    ws.send(JSON.stringify({ type: 'placeBet', clientId, amount: amt, roundId: currentRound }));
    hasBet = true; cashoutBtn.disabled = true; statusEl.textContent = 'Bet placed';
  });

  cashoutBtn.addEventListener('click', () => {
    if (!currentRound) return;
    ws.send(JSON.stringify({ type: 'cashout', clientId, roundId: currentRound }));
    hasBet = false; cashoutBtn.disabled = true; statusEl.textContent = 'Cashed out';
  });

  function renderHistory(h){ historyList.innerHTML = ''; h.forEach(r => { const li = document.createElement('li'); li.textContent = `${r.id.slice(0,6)} — ${r.crashMultiplier}x`; historyList.appendChild(li); }); }

})();
