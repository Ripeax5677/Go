// Slot Simulator
// Rules: 5 reels x 3 rows, 20 paylines, 8 symbols (including Wild W and Scatter S)
// Min bet 10000, max 500000
// Progressive jackpot: 1% of each bet goes to jackpot, 0.01% win chance
// Target RTP: 94% (house edge 6%)

const crypto = require('crypto');

// Configuration
const MIN_BET = 10000;
const MAX_BET = 10000000000;
const REELS = 5;
const ROWS = 3;
const VISIBLE = REELS * ROWS; // 15
const PAYLINES = 20; // we'll use simplified 20 straight+diagonal lines
const TARGET_RTP = 0.94;
const JACKPOT_FUND_PCT = 0.01; // 1% of each bet
const JACKPOT_WIN_CHANCE = 0.0001; // 0.01%

// Symbols: A,B,C,D,E,F (regular), W (Wild), S (Scatter)
const SYMBOLS = ['A','B','C','D','E','F','W','S'];
const WILD = 'W';
const SCATTER = 'S';

// Reel strips (symbol counts determine probabilities). We'll use equal-length strips but differing frequencies.
// Total strip length per reel
const STRIP_LENGTH = 100;
// Define frequency per symbol (sum must equal STRIP_LENGTH)
// We'll choose frequencies to give some rarities
const BASE_FREQ = {
  A: 12,
  B: 12,
  C: 12,
  D: 10,
  E: 10,
  F: 8,
  W: 8, // wild
  S: 28 // scatter slightly more frequent to allow bonus
};
// Normalize to STRIP_LENGTH
(function normalize(){
  const sum = Object.values(BASE_FREQ).reduce((a,b)=>a+b,0);
  if (sum !== STRIP_LENGTH) {
    // scale proportionally
    for (let k in BASE_FREQ) BASE_FREQ[k] = Math.max(1, Math.round(BASE_FREQ[k] * STRIP_LENGTH / sum));
  }
})();

// Make per-reel probabilities identical for simplicity
const reelProb = Array(REELS).fill(null).map(()=>{
  const map = {};
  for(const s of SYMBOLS) map[s] = (BASE_FREQ[s] || 0) / STRIP_LENGTH;
  return map;
});

// Paylines: for simplicity define 20 lines as indexes (row 0..2 per reel)
// We'll create common slot lines: straight rows, diagonals, V shapes, etc.
const PAYLINE_DEFS = [
  [1,1,1,1,1], // middle
  [0,0,0,0,0], // top
  [2,2,2,2,2], // bottom
  [0,1,2,1,0],
  [2,1,0,1,2],
  [0,0,1,0,0],
  [2,2,1,2,2],
  [1,0,0,0,1],
  [1,2,2,2,1],
  [0,1,1,1,0],
  [2,1,1,1,2],
  [0,1,0,1,0],
  [2,1,2,1,2],
  [1,1,0,1,1],
  [1,1,2,1,1],
  [0,2,0,2,0],
  [2,0,2,0,2],
  [0,1,2,2,2],
  [2,1,0,0,0],
  [0,2,1,0,2]
];

// Paytable multipliers (per symbol for 3/4/5 matches). We'll pick initial values and calibrate later.
let PAYTABLE = {
  A: {3:2, 4:5, 5:10},
  B: {3:2, 4:5, 5:10},
  C: {3:2, 4:5, 5:12},
  D: {3:3, 4:6, 5:15},
  E: {3:3, 4:7, 5:20},
  F: {3:5, 4:12, 5:50},
  // Wild has no direct pay but substitutes; we will not pay for pure wild combinations in this simplified model
};

// Scatter: no line pay; triggers bonus at 3+ scatters
const SCATTER_TRIGGER = 3;
// Bonus: when triggered, award either free spins or direct coin bonus; average bonus value will be parameterized
const AVG_BONUS_MULTIPLIER = 3; // on average bonus awards 3x bet (we'll mix randomization in simulation)

// Utility: probability of symbol S on reel r and row position is same as reelProb[r][S]
function p_at(reelIndex, symbol){
  return reelProb[reelIndex][symbol] || 0;
}

// For a given payline (rows array), probability that first N reels match symbol S considering wild substitution
function prob_match_on_line(payline, symbol, count){
  // probability that reels 0..count-1 each are either symbol or wild
  let p = 1;
  for (let r=0;r<count;r++){
    const reelIdx = r;
    const probSym = p_at(reelIdx, symbol);
    const probWild = p_at(reelIdx, WILD);
    p *= (probSym + probWild);
  }
  // Exclude the case where the (count+1)th reel also matches (for exact count) if count < 5
  if (count < REELS){
    const nextProb = p_at(count, symbol) + p_at(count, WILD);
    p = p * (1 - nextProb);
  }
  return p;
}

// For a payline, compute expected payout per bet (sum over symbols and counts)
function expected_payout_per_line(){
  let ev = 0;
  for (const line of PAYLINE_DEFS){
    // For simplicity we assume each reel's position prob equals overall per-reel prob (uniform over rows)
    for (const sym of ['A','B','C','D','E','F']){
      for (const cnt of [3,4,5]){
        const p = prob_match_on_line(line, sym, cnt);
        const mult = PAYTABLE[sym] && PAYTABLE[sym][cnt] ? PAYTABLE[sym][cnt] : 0;
        ev += p * mult;
      }
    }
  }
  // average per-line (since PAYLINES lines exist), but above already summed across lines
  return ev; // payout multiplier (times bet) summed across all lines
}

// Scatter EV: compute probability of k scatters across 15 visible positions
function scatter_ev(){
  const pScatter = reelProb[0][SCATTER]; // same for all positions
  const n = VISIBLE;
  let ev = 0;
  for (let k=SCATTER_TRIGGER;k<=n;k++){
    const comb = binomial(n,k);
    const prob = comb * Math.pow(pScatter,k) * Math.pow(1-pScatter,n-k);
    // average bonus payout in coins = AVG_BONUS_MULTIPLIER * bet
    ev += prob * AVG_BONUS_MULTIPLIER;
  }
  return ev; // in units of bet
}

// Jackpot EV: with given jackpot probability and expected payout equal to current pool which grows by 1% per spin.
// For long-run fairness we'll assume the average jackpot payout per spin equals the contribution (1% of bet).
function jackpot_ev(){
  // expected return to player from jackpot = chance * expected payout
  // By design expected payout equals contribution: JACKPOT_WIN_CHANCE * avgPayout == JACKPOT_FUND_PCT
  // So EV contribution equals JACKPOT_FUND_PCT
  return JACKPOT_FUND_PCT; // in fraction of bet
}

// Binomial helper
function binomial(n,k){
  if (k<0 || k>n) return 0;
  k = Math.min(k, n-k);
  let c = 1;
  for (let i=0;i<k;i++){ c = c * (n-i) / (i+1); }
  return c;
}

// Compute total theoretical RTP (per unit bet)
function compute_rtp(){
  // Line payouts
  const line_ev = expected_payout_per_line();
  // since above sums across PAYLINE_DEFS, total lines count equals PAYLINES
  const total_line_ev = line_ev; // already summed
  // Scatter EV
  const s_ev = scatter_ev();
  // Jackpot EV
  const j_ev = jackpot_ev();
  // Sum: total return in multiples of bet. We must divide line_ev by number of paylines? No - our expected_payout_per_line summed payouts per all lines per spin.
  // So RTP = total_line_ev + s_ev + j_ev
  const rtp = total_line_ev + s_ev + j_ev;
  return { rtp, breakdown: { lines: total_line_ev, scatter: s_ev, jackpot: j_ev } };
}

// Calibration: scale PAYTABLE multipliers to reach target RTP (simple proportional scaling)
function calibrate_paytable(){
  const before = compute_rtp();
  const scale = TARGET_RTP / before.rtp;
  for (const s of Object.keys(PAYTABLE)){
    for (const cnt of Object.keys(PAYTABLE[s])){
      PAYTABLE[s][cnt] = Math.max(1, Math.round(PAYTABLE[s][cnt] * scale));
    }
  }
  const after = compute_rtp();
  return { before, after, scale };
}

// RNG spin: generate visible grid randomly according to reel probabilities
function sample_visible(){
  // For each reel, sample 3 visible rows independently from strip (approximation)
  const grid = Array(ROWS).fill(null).map(()=>Array(REELS).fill(null));
  for (let r=0;r<REELS;r++){
    for (let row=0;row<ROWS;row++){
      const sym = weightedSample(reelProb[r]);
      grid[row][r] = sym;
    }
  }
  return grid; // rows x reels
}

function weightedSample(probMap){
  const rnd = crypto.randomBytes(6).readUIntBE(0,6) / 0xffffffffffffn;
  let acc = 0;
  for (const s of SYMBOLS){
    acc += probMap[s] || 0;
    if (rnd <= acc) return s;
  }
  return SYMBOLS[SYMBOLS.length-1];
}

// Evaluate a spin: returns payout multiplier (including bet) and details
function evaluate_spin(grid, bet){
  // Lines
  let totalPayout = 0;
  const combos = [];
  for (const line of PAYLINE_DEFS){
    // determine left-to-right matching symbol (non-scatter). Wilds substitute.
    // Find symbol candidate at first reel
    const firstSym = grid[line[0]][0];
    // Candidate symbols are actual symbol if not scatter, or if wild then we need to check next non-wild
    let baseSymbols = SYMBOLS.filter(s=>s!==WILD && s!==SCATTER);
    // For each base symbol, check contiguous match length
    for (const sym of baseSymbols){
      let matchLen = 0;
      for (let r=0;r<REELS;r++){
        const cell = grid[line[r]][r];
        if (cell === sym || cell === WILD) matchLen++; else break;
      }
      if (matchLen >= 3 && PAYTABLE[sym] && PAYTABLE[sym][matchLen]){
        const mult = PAYTABLE[sym][matchLen];
        const payout = mult * bet;
        totalPayout += payout;
        combos.push({ line, symbol: sym, len: matchLen, mult, payout });
      }
    }
  }
  // Scatter
  let scatterCount = 0;
  for (let r=0;r<REELS;r++) for (let row=0;row<ROWS;row++) if (grid[row][r] === SCATTER) scatterCount++;
  let bonus = null;
  if (scatterCount >= SCATTER_TRIGGER){
    // Trigger bonus: either direct coin award or freespins with multipliers. We'll randomize small.
    const rnd = Math.random();
    if (rnd < 0.5){
      // coin bonus: random 1x-10x
      const mult = 1 + Math.floor(Math.random()*10);
      const payout = mult * bet;
      totalPayout += payout;
      bonus = { type: 'coin', mult, payout };
    } else {
      // freespins: award N free spins with average win per spin = 0.5*bet*AVG_BONUS_MULTIPLIER
      const spins = 5 + Math.floor(Math.random()*11); // 5-15
      const averageSpinWin = 0.5 * AVG_BONUS_MULTIPLIER * bet;
      const payout = spins * averageSpinWin;
      totalPayout += payout;
      bonus = { type: 'freespins', spins, payout };
    }
  }
  // Jackpot check
  let jackpotWin = false;
  if (Math.random() < JACKPOT_WIN_CHANCE){
    jackpotWin = true;
    const jackpotPayout = bet * 100; // as reasoned, average ~100x bet
    totalPayout += jackpotPayout;
  }
  return { totalPayout, combos, bonus, scatterCount, jackpotWin };
}

// Quick calibration and print
function main(){
  console.log('BASE_FREQ', BASE_FREQ);
  console.log('Initial PAYTABLE', PAYTABLE);
  const calib = calibrate_paytable();
  console.log('Calibrated PAYTABLE', PAYTABLE);
  console.log('RTP before scaling:', calib.before);
  console.log('RTP after scaling:', calib.after);

  // compute EV per spin (per unit bet)
  const r = compute_rtp();
  console.log('Computed RTP breakdown (per unit bet):', r.breakdown, 'TOTAL RTP=', r.rtp.toFixed(4));

  // Run a simulation of spins
  const bet = 10000;
  const spins = 10000;
  let balance = 1000000;
  let totalPayout = 0;
  let jackpotPool = 0;
  for (let i=0;i<spins;i++){
    // Autospin: deduct bet
    balance -= bet;
    // fund jackpot
    jackpotPool += bet * JACKPOT_FUND_PCT;
    const grid = sample_visible();
    const result = evaluate_spin(grid, bet);
    totalPayout += result.totalPayout;
    balance += result.totalPayout;
    if (result.jackpotWin){
      // award jackpot pool
      balance += jackpotPool;
      totalPayout += jackpotPool;
      jackpotPool = 0;
    }
  }
  console.log(`Simulated ${spins} spins @ bet ${bet}: netReturn=${totalPayout/spins/bet}x (RTP estimate)`);

  // Demonstrate a single detailed spin
  const grid = sample_visible();
  const detail = evaluate_spin(grid, 50000);
  console.log('Sample grid:');
  for (let r=0;r<ROWS;r++) console.log(grid[r].join(' | '));
  console.log('Spin result (bet 50000):', detail);
  // EV per spin (theoretical)
  const theoretical = compute_rtp();
  console.log('Theoretical EV per bet (RTP):', theoretical.rtp);
}

if (require.main === module) main();

module.exports = { main };
