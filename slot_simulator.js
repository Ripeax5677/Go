const crypto = require('crypto');

const REELS = 5;
const ROWS = 3;
const WILD = 'W';
const SCATTER = 'S';

const SYMBOLS = ['A','B','C','D','E','F','W','S'];

const reelProb = Array(REELS).fill({
  A:0.14,B:0.14,C:0.14,D:0.12,E:0.12,F:0.08,
  W:0.04,S:0.02
});

const PAYLINES = [
  [1,1,1,1,1],
  [0,0,0,0,0],
  [2,2,2,2,2],
  [0,1,2,1,0],
  [2,1,0,1,2]
];

const PAYTABLE = {
  A:{3:1,4:3,5:8},
  B:{3:1,4:3,5:8},
  C:{3:1,4:4,5:10},
  D:{3:2,4:5,5:15},
  E:{3:2,4:6,5:20},
  F:{3:4,4:10,5:40}
};

function rand(){
  return crypto.randomBytes(4).readUInt32BE(0)/0xffffffff;
}

function spinGrid(){
  const g = Array(ROWS).fill(0).map(()=>Array(REELS));
  for(let r=0;r<REELS;r++){
    for(let y=0;y<ROWS;y++){
      let acc=0,x=rand();
      for(const s of SYMBOLS){
        acc+=reelProb[r][s];
        if(x<=acc){ g[y][r]=s; break; }
      }
    }
  }
  return g;
}

function evalSpin(grid, bet){
  let payout = 0;
  const wins = [];

  for(const line of PAYLINES){
    let best = 0;
    let bestSym = null;

    for(const sym of Object.keys(PAYTABLE)){
      let m=0;
      for(let r=0;r<REELS;r++){
        const c = grid[line[r]][r];
        if(c===sym||c===WILD) m++; else break;
      }
      if(m>=3 && PAYTABLE[sym][m]){
        const w = PAYTABLE[sym][m];
        if(w>best){ best=w; bestSym=sym; }
      }
    }

    if(best>0){
      const win = best*bet;
      payout+=win;
      wins.push({line,symbol:bestSym,mult:best,payout:win});
    }
  }

  let scatters=0;
  grid.flat().forEach(c=>c===SCATTER&&scatters++);
  if(scatters>=3){
    if(rand()<0.25){
      const bonus = bet*(2+Math.floor(rand()*4));
      payout+=bonus;
      wins.push({type:'scatter',payout:bonus});
    }
  }

  return { payout, wins };
}

module.exports = { spinGrid, evalSpin };
