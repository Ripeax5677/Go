// Emoji Donut Slot client-side simulator
// 5 reels x 3 rows, 20 paylines, min bet 10000, max 500000
(function(){
  const MIN_BET = 10000;
  const MAX_BET = 500000;
  const REELS = 5, ROWS = 3;
  const PAYLINES = [
    [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],
    [0,0,1,0,0],[2,2,1,2,2],[1,0,0,0,1],[1,2,2,2,1],[0,1,1,1,0],
    [2,1,1,1,2],[0,1,0,1,0],[2,1,2,1,2],[1,1,0,1,1],[1,1,2,1,1],
    [0,2,0,2,0],[2,0,2,0,2],[0,1,2,2,2],[2,1,0,0,0],[0,2,1,0,2]
  ];
  // Symbols (emoji): Donut is primary, W = Wild (⭐), Scatter = 🍀
  const SYMBOLS = ['🍩','🍒','🍋','🔔','💎','🍇','⭐','🍀'];
  const WILD = '⭐', SCATTER = '🍀';
  const PAYTABLE = {
    '🍩': {3:5,4:12,5:40},
    '🍒': {3:2,4:6,5:15},
    '🍋': {3:2,4:5,5:12},
    '🔔': {3:3,4:8,5:20},
    '💎': {3:5,4:15,5:50},
    '🍇': {3:3,4:7,5:18}
  };
  const JACKPOT_CHANCE = 0.0001; // 0.01%
  const JACKPOT_MULT = 100; // payout multiplier when jackpot hit
  // Simple symbol weights (sum arbitrary but used relatively)
  const WEIGHTS = { '🍩':10,'🍒':12,'🍋':12,'🔔':9,'💎':6,'🍇':10,'⭐':8,'🍀':33 };
  const weightList = [];
  for (const s of SYMBOLS) for (let i=0;i<WEIGHTS[s];i++) weightList.push(s);

  function rndSymbol(){
    const r = cryptoInt(weightList.length);
    return weightList[r];
  }
  function cryptoInt(max){
    const u = new Uint32Array(1);
    window.crypto.getRandomValues(u);
    return u[0] % max;
  }

  // DOM
  const playBtn = document.getElementById('playSlot');
  const backBtn = document.getElementById('backFromSlot');
  const slotArea = document.querySelector('.slotArea');
  const mainSections = document.querySelectorAll('section.startPanel, section.gameArea, section.minesArea, section.crashArea');
  const slotGridEl = document.getElementById('slotGrid');
  const spinBtn = document.getElementById('slotSpin');
  const betInput = document.getElementById('slotBet');
  const slotResult = document.getElementById('slotResult');
  const slotJackpotEl = document.getElementById('slotJackpot');
  const autoCheckbox = document.getElementById('slotAuto');

  let jackpotPool = 0;
  let autoSpinTimer = null;

  function showSlot(){
    mainSections.forEach(s=>s.classList.add('hidden'));
    slotArea.classList.remove('hidden');
    renderEmptyGrid();
    updateJackpotDisplay();
  }
  function hideSlot(){
    slotArea.classList.add('hidden');
    document.querySelector('section.startPanel').classList.remove('hidden');
    stopAuto();
  }

  playBtn && playBtn.addEventListener('click', showSlot);
  backBtn && backBtn.addEventListener('click', hideSlot);

  function renderEmptyGrid(){
    slotGridEl.innerHTML = '';
    for (let r=0;r<ROWS;r++) for (let c=0;c<REELS;c++){
      const div = document.createElement('div'); div.className='cell'; div.textContent='—';
      slotGridEl.appendChild(div);
    }
  }

  function renderGrid(grid){
    slotGridEl.innerHTML = '';
    for (let row=0;row<ROWS;row++){
      for (let col=0;col<REELS;col++){
        const div = document.createElement('div'); div.className='cell'; div.textContent = grid[row][col];
        slotGridEl.appendChild(div);
      }
    }
  }

  function sampleGrid(){
    const grid = Array.from({length:ROWS},()=>Array(REELS).fill(null));
    for (let c=0;c<REELS;c++) for (let r=0;r<ROWS;r++) grid[r][c]=rndSymbol();
    return grid;
  }

  function evaluate(grid, bet){
    let total = 0; const combos = [];
    // Lines
    for (const line of PAYLINES){
      // Determine left-to-right longest match for each base symbol
      for (const sym of Object.keys(PAYTABLE)){
        let len=0;
        for (let c=0;c<REELS;c++){
          const cell = grid[line[c]][c];
          if (cell===sym || cell===WILD) len++; else break;
        }
        if (len>=3){
          const mult = PAYTABLE[sym][len]||0;
          const payout = mult * bet;
          total += payout; combos.push({line, sym, len, mult, payout});
        }
      }
    }
    // Scatter
    let scat=0; for (let r=0;r<ROWS;r++) for (let c=0;c<REELS;c++) if (grid[r][c]===SCATTER) scat++;
    let bonus=null;
    if (scat>=3){
      // coin bonus 50% or freespins 50%
      if (Math.random()<0.5){
        const mult = 1 + Math.floor(Math.random()*10);
        const payout = mult * bet; total += payout; bonus={type:'coin',mult,payout};
      } else {
        const spins = 5 + Math.floor(Math.random()*11);
        const payout = spins * (0.5 * bet); total += payout; bonus={type:'freespins',spins,payout};
      }
    }
    // Jackpot
    let jackpot=false;
    if (Math.random() < JACKPOT_CHANCE){
      jackpot=true; const jp = bet * JACKPOT_MULT; total += jp; jackpotPool = 0; updateJackpotDisplay();
    }
    return { total, combos, bonus, scatterCount:scat, jackpot };
  }

  // --- Fairness math: compute theoretical RTP (per-unit-bet)
  function computeRTP(){
    const totalWeight = Object.values(WEIGHTS).reduce((a,b)=>a+b,0);
    const p = {};
    for (const s of SYMBOLS) p[s] = (WEIGHTS[s]||0)/totalWeight;
    const pWild = p[WILD] || 0;
    // Line EV
    let lineEV = 0;
    for (const line of PAYLINES){
      for (const sym of Object.keys(PAYTABLE)){
        for (const cnt of [3,4,5]){
          // probability that first cnt reels are sym or wild
          let prob = 1;
          for (let r=0;r<cnt;r++){
            prob *= (p[sym] + pWild);
          }
          if (cnt < REELS){
            const nextProb = (p[sym] + pWild);
            prob *= (1 - nextProb);
          }
          const mult = PAYTABLE[sym][cnt] || 0;
          lineEV += prob * mult;
        }
      }
    }
    // Scatter EV using binomial over 15 visible positions
    const n = ROWS * REELS;
    const pScatter = p[SCATTER] || 0;
    let scatterEV = 0;
    for (let k=3;k<=n;k++){
      const comb = binomial(n,k);
      const probK = comb * Math.pow(pScatter,k) * Math.pow(1-pScatter,n-k);
      // assume average bonus equals 3x bet (conservative)
      scatterEV += probK * 3;
    }
    // Jackpot EV: expected return equals 1% contribution
    const jackpotEV = 0.01;
    return { rtp: lineEV + scatterEV + jackpotEV, breakdown:{lines:lineEV, scatter:scatterEV, jackpot:jackpotEV} };
  }

  function binomial(n,k){
    if (k<0 || k>n) return 0;
    k = Math.min(k, n-k);
    let c = 1;
    for (let i=0;i<k;i++) c = c * (n-i) / (i+1);
    return c;
  }


  function updateJackpotDisplay(){ slotJackpotEl.textContent = Math.round(jackpotPool); }

  function performSpin(){
    const bet = parseInt(betInput.value)||0;
    if (isNaN(bet) || bet < MIN_BET){ slotResult.textContent = `Bet must be >= ${MIN_BET}`; return; }
    if (bet > MAX_BET){ slotResult.textContent = `Bet must be <= ${MAX_BET}`; return; }
    // Contribute to jackpot
    jackpotPool += bet * 0.01; updateJackpotDisplay();
    // Sample
    const grid = sampleGrid();
    renderGrid(grid);
    const res = evaluate(grid, bet);
    const win = res.total;
    const theoretical = computeRTP();
    const ev = theoretical.rtp * bet; // theoretical EV
    // Output summary
    let out = [];
    out.push(`Bet: ${bet}`);
    out.push(`Win: ${win} (includes bet)`);
    if (res.combos.length) out.push(`Combos: ${res.combos.map(c=>`${c.sym} x${c.len} on line => ${c.payout}`).join('; ')}`);
    else out.push('Combos: none');
    out.push(`Bonus: ${res.bonus ? JSON.stringify(res.bonus) : 'no'}`);
    out.push(`Jackpot won: ${res.jackpot ? 'YES' : 'no'}`);
    out.push(`Theoretical EV: ${ev.toFixed(2)} (RTP ${(theoretical.rtp*100).toFixed(4)}%)`);
    out.push(`House check: RTP ${(theoretical.rtp*100).toFixed(4)}% vs target 94%`);
    slotResult.innerHTML = out.join('<br/>');
  }

  spinBtn && spinBtn.addEventListener('click', performSpin);
  autoCheckbox && autoCheckbox.addEventListener('change', ()=>{
    if (autoCheckbox.checked) startAuto(); else stopAuto();
  });
  function startAuto(){ if (autoSpinTimer) return; autoSpinTimer = setInterval(()=>{ performSpin(); }, 800); }
  function stopAuto(){ if (!autoSpinTimer) return; clearInterval(autoSpinTimer); autoSpinTimer=null; }

  // init grid
  renderEmptyGrid();
})();
