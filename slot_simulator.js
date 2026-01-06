const crypto = require("crypto");

/* ================= CONFIG ================= */

const MIN_BET = 10000;
const MAX_BET = 10000000000;

const REELS = 5;
const ROWS = 3;
const PAYLINES = 20;

const TARGET_RTP = 0.94;
const JACKPOT_FUND_PCT = 0.01;
const JACKPOT_WIN_CHANCE = 0.00005; // 0.005%

const SYMBOLS = ["A","B","C","D","E","F","W","S"];
const WILD = "W";
const SCATTER = "S";

/* ================= REEL PROB ================= */

const BASE_FREQ = {
  A: 18,
  B: 18,
  C: 16,
  D: 14,
  E: 12,
  F: 10,
  W: 6,
  S: 6
};

const STRIP_LENGTH = Object.values(BASE_FREQ).reduce((a,b)=>a+b,0);

const reelProb = Array(REELS).fill(null).map(() => {
  const p = {};
  for (const s of SYMBOLS) p[s] = (BASE_FREQ[s] || 0) / STRIP_LENGTH;
  return p;
});

/* ================= PAYLINES ================= */

const PAYLINE_DEFS = [
  [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],
  [0,1,2,1,0],[2,1,0,1,2],
  [1,0,1,0,1],[1,2,1,2,1],
  [0,1,1,1,0],[2,1,1,1,2],
  [0,0,1,0,0],[2,2,1,2,2],
  [1,1,0,1,1],[1,1,2,1,1],
  [0,2,0,2,0],[2,0,2,0,2],
  [0,1,0,1,0],[2,1,2,1,2],
  [1,0,0,0,1],[1,2,2,2,1],
  [0,2,1,0,2]
];

/* ================= PAYTABLE ================= */

const PAYTABLE = {
  A: {3:1, 4:3, 5:6},
  B: {3:1, 4:3, 5:6},
  C: {3:2, 4:4, 5:8},
  D: {3:2, 4:5, 5:10},
  E: {3:3, 4:7, 5:15},
  F: {3:5, 4:12, 5:40}
};

/* ================= RNG ================= */

function weightedSample(prob) {
  const r = crypto.randomInt(0, 1e9) / 1e9;
  let acc = 0;
  for (const s of SYMBOLS) {
    acc += prob[s];
    if (r <= acc) return s;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function sample_visible() {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: REELS }, (_, r) => weightedSample(reelProb[r]))
  );
}

/* ================= EVALUATION ================= */

function evaluate_spin(grid, bet) {
  let win = 0;
  const combos = [];

  for (const line of PAYLINE_DEFS) {
    for (const sym of Object.keys(PAYTABLE)) {
      let len = 0;
      for (let r = 0; r < REELS; r++) {
        const cell = grid[line[r]][r];
        if (cell === sym || cell === WILD) len++;
        else break;
      }
      if (len >= 3 && PAYTABLE[sym][len]) {
        const payout = PAYTABLE[sym][len] * bet;
        win += payout;
        combos.push({ symbol: sym, len, payout });
      }
    }
  }

  /* ===== SCATTER BONUS (LIMITED) ===== */

  let scatterCount = 0;
  for (const row of grid)
    for (const c of row)
      if (c === SCATTER) scatterCount++;

  let bonus = null;
  if (scatterCount >= 3) {
    const mult = 2; // FIXED bonus
    const payout = mult * bet;
    win += payout;
    bonus = { type: "coin", mult, payout };
  }

  /* ===== JACKPOT ===== */

  let jackpotWin = false;
  if (Math.random() < JACKPOT_WIN_CHANCE) {
    jackpotWin = true;
    win += bet * 50;
  }

  return { win, combos, bonus, jackpotWin };
}

/* ================= EXPORT ================= */

module.exports = {
  sample_visible,
  evaluate_spin
};
