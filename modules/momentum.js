'use strict';

// ── Time-Series Momentum (TSMOM) ──────────────────────────────────────────────
// Moskowitz, Ooi & Pedersen (2012): "Time Series Momentum"
// Signal: buy if own N-month return is positive, short if negative
// Skip most recent month (Asness convention) to avoid short-term reversal

function tsmomSignal(closes, lookbacks = [21, 63, 126, 252]) {
  if (closes.length < 252 + 22) {
    // Use whatever data we have
    lookbacks = lookbacks.filter(lb => closes.length > lb + 5);
    if (!lookbacks.length) return { tsmomScore: 0, confidence: 0, signals: {}, allAgree: false };
  }

  const current = closes[closes.length - 1];
  const signals = {};

  for (const lb of lookbacks) {
    if (closes.length < lb + 21) continue;

    const pastPrice = closes[closes.length - lb - 21]; // skip last ~month
    const ret = (current - pastPrice) / pastPrice;

    // Volatility-scaled signal (risk parity weighting)
    const window = Math.min(lb, closes.length - 1);
    const slice  = closes.slice(-window - 1);
    const returns = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
    const mean   = returns.reduce((s, v) => s + v, 0) / returns.length;
    const vol    = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length * 252);

    signals[`tsmom_${lb}d`] = {
      rawReturn: ret,
      volatility: vol,
      scaled: vol > 0 ? ret / vol : ret * 10,
      direction: ret > 0 ? 1 : -1,
      label: lb === 21 ? '1M' : lb === 63 ? '3M' : lb === 126 ? '6M' : '12M',
    };
  }

  const dirs    = Object.values(signals).map(s => s.direction);
  const scaleds = Object.values(signals).map(s => s.scaled);
  if (!dirs.length) return { tsmomScore: 0, confidence: 0, signals, allAgree: false };

  const avgDir = dirs.reduce((s, v) => s + v, 0) / dirs.length;
  const allAgree = Math.abs(avgDir) === 1.0;

  // Use magnitude of vol-adjusted (Sharpe-normalized) returns — not just direction.
  // This makes TSMOM proportional to trend strength, not a binary ±10 flag.
  // tanh(x/2) maps: weak trend (Sharpe ≈ 0.5) → ±4.6, strong (≈1.5) → ±7.2, very strong (≈3) → ±9.1
  const avgScaled  = scaleds.reduce((s, v) => s + v, 0) / scaleds.length;
  const tsmomScore = Math.max(-10, Math.min(10, Math.tanh(avgScaled / 2) * 10));
  const confidence = Math.min(1, Math.abs(avgScaled) / 3);

  return { tsmomScore, confidence, signals, allAgree };
}

// ── Cross-Asset TSMOM Matrix ──────────────────────────────────────────────────
function crossAssetMomentum(assetData) {
  const riskOn  = ['SPY', 'QQQ', 'IWM', 'HYG', 'XLY', 'SMH'];
  const riskOff = ['TLT', 'GLD'];

  const scores = {};
  for (const [ticker, bars] of Object.entries(assetData)) {
    if (!bars?.length) continue;
    const closes = bars.map(b => b.close);
    const r = tsmomSignal(closes, [21, 63, 126]);
    scores[ticker] = r.tsmomScore;
  }

  const riskOnScores  = riskOn.filter(t => t in scores).map(t => scores[t]);
  const riskOffScores = riskOff.filter(t => t in scores).map(t => scores[t]);

  const riskOnMean  = riskOnScores.length ? riskOnScores.reduce((s, v) => s + v, 0) / riskOnScores.length : 0;
  const riskOffMean = riskOffScores.length ? riskOffScores.reduce((s, v) => s + v, 0) / riskOffScores.length : 0;

  // Bull = risk-on trending up AND risk-off trending down
  const composite = riskOnMean - riskOffMean;

  return {
    riskOnScore:  riskOnMean,
    riskOffScore: riskOffMean,
    composite,
    regime: composite > 5 ? 'RISK_ON' : composite < -5 ? 'RISK_OFF' : 'MIXED',
    biasScore: Math.max(-10, Math.min(10, composite / 2)),
    tickerScores: scores,
  };
}

// ── PDH / PDL Signal ─────────────────────────────────────────────────────────
// ICT-style: where price is relative to previous day's high/low
function pdhPdlScore(bars) {
  if (bars.length < 2) return { score: 0, abovePDH: false, belowPDL: false };

  const prev    = bars[bars.length - 2];
  const current = bars[bars.length - 1];
  const spot    = current.close;

  const pdh = prev.high;
  const pdl = prev.low;
  const prevRange = pdh - pdl;

  const distFromPDH = (spot - pdh) / prevRange;
  const distFromPDL = (spot - pdl) / prevRange;

  // Above PDH → bullish (broken prior resistance)
  // Below PDL → bearish (broken prior support)
  // In range: proportional bias
  let score;
  if (spot > pdh) score = Math.min(8, 5 + distFromPDH * 10);
  else if (spot < pdl) score = Math.max(-8, -5 + distFromPDH * 10);
  else score = (distFromPDL - 0.5) * 8; // linear within range

  return {
    score: Math.max(-10, Math.min(10, score)),
    pdh,
    pdl,
    spot,
    abovePDH: spot > pdh,
    belowPDL: spot < pdl,
    inRange: spot >= pdl && spot <= pdh,
  };
}

// ── EMA Stack Score ───────────────────────────────────────────────────────────
function emaValue(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function emaStackScore(closes) {
  if (closes.length < 200) {
    // Fallback to shorter EMAs
    const e8  = emaValue(closes, Math.min(8, closes.length - 1));
    const e21 = emaValue(closes, Math.min(21, closes.length - 1));
    const spot = closes[closes.length - 1];
    let score = 0;
    if (spot > e8)  score += 3; else score -= 3;
    if (e8  > e21)  score += 3; else score -= 3;
    score = Math.max(-6, Math.min(6, score));
    return { score, e8, e21, e50: null, e200: null, spot };
  }

  const spot = closes[closes.length - 1];
  const e8   = emaValue(closes, 8);
  const e21  = emaValue(closes, 21);
  const e50  = emaValue(closes, 50);
  const e200 = emaValue(closes, 200);

  // Continuous EMA stack score:
  // For each pair, compute the percentage gap and scale it with tanh so
  // extreme distances are dampened. Direction (binary ±) × magnitude (tanh).
  // Each condition contributes up to ±2, total range stays ±10.
  const pctGap = (a, b) => (a - b) / b; // signed % above/below
  const softScore = (gap, maxSensitivity = 0.02) => {
    // tanh maps ±maxSensitivity gap → ±0.76; ±2× → ±0.96
    // multiply by 2 so each condition contributes ±0 to ±2
    return Math.tanh(gap / maxSensitivity) * 2;
  };

  // Conditions scored by magnitude of gap, not just direction
  const s1 = softScore(pctGap(spot, e8),   0.008); // short-term: 0.8% = full signal
  const s2 = softScore(pctGap(e8,   e21),  0.006); // structure tightens over time
  const s3 = softScore(pctGap(e21,  e50),  0.008);
  const s4 = softScore(pctGap(e50,  e200), 0.015); // long-term trend: needs 1.5% gap
  const s5 = softScore(pctGap(spot, e200), 0.025); // distance from 200: 2.5% = full signal

  const score = Math.max(-10, Math.min(10, s1 + s2 + s3 + s4 + s5));

  return { score, spot, e8, e21, e50, e200,
    gaps: { spotVsE8: (pctGap(spot,e8)*100).toFixed(2)+'%', e8VsE21: (pctGap(e8,e21)*100).toFixed(2)+'%', e21VsE50: (pctGap(e21,e50)*100).toFixed(2)+'%', spotVsE200: (pctGap(spot,e200)*100).toFixed(2)+'%' } };
}

// ── Order Flow Imbalance (volume proxy) ──────────────────────────────────────
// Cont, Kukanov & Stoikov (2010): price impact of order book events
// Proxy: up-volume vs down-volume (OBV-normalized)
function computeOFI(bars, window = 14) {
  if (bars.length < window + 10) return { score: 0, ofi: 0, ofiZscore: 0, interpretation: 'NO_DATA' };

  // Compute up/down volume for each bar
  const upVol = bars.map(b => b.close > b.open ? b.volume : 0);
  const dnVol = bars.map(b => b.close < b.open ? b.volume : 0);

  // Rolling OFI
  const ofiSeries = [];
  for (let i = window; i < bars.length; i++) {
    const up  = upVol.slice(i - window, i).reduce((s, v) => s + v, 0);
    const dn  = dnVol.slice(i - window, i).reduce((s, v) => s + v, 0);
    const tot = up + dn;
    ofiSeries.push(tot > 0 ? (up - dn) / tot : 0);
  }

  if (!ofiSeries.length) return { score: 0, ofi: 0, ofiZscore: 0, interpretation: 'NO_DATA' };

  const currentOFI = ofiSeries[ofiSeries.length - 1];
  const longWindow = Math.min(60, ofiSeries.length);
  const hist = ofiSeries.slice(-longWindow);
  const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
  const std  = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length);
  const ofiZscore = std > 0 ? (currentOFI - mean) / std : 0;

  let interpretation = 'BALANCED';
  if (ofiZscore > 1.5) interpretation = 'INSTITUTIONAL_BUYING';
  else if (ofiZscore < -1.5) interpretation = 'INSTITUTIONAL_SELLING';
  else if (ofiZscore > 0.5) interpretation = 'MILD_BUYING';
  else if (ofiZscore < -0.5) interpretation = 'MILD_SELLING';

  // Check for price-OFI divergence
  const recentPrices = bars.slice(-20).map(b => b.close);
  const priceUp = recentPrices[recentPrices.length - 1] > recentPrices[0];
  const ofiUp   = ofiSeries[ofiSeries.length - 1] > ofiSeries[Math.max(0, ofiSeries.length - 20)];
  let divergence = 'NONE';
  if (priceUp && !ofiUp)  divergence = 'BEARISH_DIVERGENCE';
  if (!priceUp && ofiUp)  divergence = 'BULLISH_DIVERGENCE';

  const score = Math.max(-10, Math.min(10, ofiZscore * 4));

  return { score, ofi: currentOFI, ofiZscore, interpretation, divergence };
}

// ── Intraday momentum (first 30min → last 30min) ─────────────────────────────
// Gao, Han, Li & Zhou (2018): "Intraday Momentum"
function intradayMomentumScore(bars) {
  if (bars.length < 2) return { score: 0, type: 'NO_DATA' };

  const today    = bars[bars.length - 1];
  const prev     = bars[bars.length - 2];
  const spot     = today.close;
  const prevClose = prev.close;

  // Overnight gap signal (Lou et al. 2019)
  const gapReturn = (today.open - prevClose) / prevClose;

  // Intraday direction (open-to-close as proxy for first-30min → last-30min)
  const intradayReturn = (today.close - today.open) / today.open;

  // Volume ratio (vs previous day)
  const volRatio = prev.volume > 0 ? today.volume / prev.volume : 1;

  const threshold = 0.003;
  let score = 0, type = 'NEUTRAL';

  // Gap signal
  if (gapReturn > threshold) {
    score += 3 * Math.min(Math.abs(gapReturn) / 0.01, 1);
    type = 'GAP_UP';
  } else if (gapReturn < -threshold) {
    score -= 3 * Math.min(Math.abs(gapReturn) / 0.01, 1);
    type = 'GAP_DOWN';
  }

  // Intraday continuation signal (amplified by volume)
  if (intradayReturn > threshold && volRatio > 1.3) {
    score += 4 * Math.min(Math.abs(intradayReturn) / 0.01, 1);
    type = type === 'GAP_UP' ? 'STRONG_BULL_INTRADAY' : 'BULL_INTRADAY';
  } else if (intradayReturn < -threshold && volRatio > 1.3) {
    score -= 4 * Math.min(Math.abs(intradayReturn) / 0.01, 1);
    type = type === 'GAP_DOWN' ? 'STRONG_BEAR_INTRADAY' : 'BEAR_INTRADAY';
  }

  return {
    score: Math.max(-10, Math.min(10, score)),
    type,
    gapReturn,
    intradayReturn,
    volRatio,
  };
}

// ── VWAP Z-score ─────────────────────────────────────────────────────────────
function vwapZScore(bars, window = 20) {
  if (bars.length < window) return { score: 0, zScore: 0 };

  const slice = bars.slice(-window);
  const totalVol = slice.reduce((s, b) => s + b.volume, 0);
  const vwap = totalVol > 0
    ? slice.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / totalVol
    : slice[slice.length - 1].close;

  const spot = slice[slice.length - 1].close;
  const prices = slice.map(b => b.close);
  const mean  = prices.reduce((s, v) => s + v, 0) / prices.length;
  const std   = Math.sqrt(prices.reduce((s, v) => s + (v - mean) ** 2, 0) / prices.length);
  const zScore = std > 0 ? (spot - vwap) / std : 0;

  // Positive zScore = above VWAP = bullish bias for day traders
  const score = Math.max(-10, Math.min(10, zScore * 3));

  return { score, zScore, vwap, spot };
}

// ── Fair Value Gap (FVG) Detection ────────────────────────────────────────────
// ICT concept: three-candle pattern where a gap exists between candle[i-2] and candle[i]
// Bullish FVG: candle[i].low > candle[i-2].high — gap forms above (support on pullback)
// Bearish FVG: candle[i].high < candle[i-2].low — gap forms below (resistance on rally)
// Unmitigated gaps (price hasn't retraced into them) are the active signals.
function detectFairValueGaps(bars, lookback = 50) {
  if (bars.length < 3) return { score: 0, gaps: [], interpretation: 'NO_DATA' };

  const gaps = [];
  const start = Math.max(2, bars.length - lookback - 1);

  for (let i = start; i < bars.length; i++) {
    const b0 = bars[i - 2]; // anchor candle
    const b2 = bars[i];     // displacement candle

    // Bullish FVG: displacement candle's low is above anchor's high
    if (b2.low > b0.high) {
      gaps.push({ type: 'BULL', hi: b2.low, lo: b0.high, mid: (b2.low + b0.high) / 2, idx: i, date: b2.date, mitigated: false });
    }
    // Bearish FVG: displacement candle's high is below anchor's low
    else if (b2.high < b0.low) {
      gaps.push({ type: 'BEAR', hi: b0.low, lo: b2.high, mid: (b0.low + b2.high) / 2, idx: i, date: b2.date, mitigated: false });
    }
  }

  // Mark gaps mitigated if price has subsequently traded into the gap zone
  for (const g of gaps) {
    for (let j = g.idx + 1; j < bars.length; j++) {
      if (bars[j].low <= g.hi && bars[j].high >= g.lo) { g.mitigated = true; break; }
    }
  }

  const spot = bars[bars.length - 1].close;
  const unmitigated = gaps.filter(g => !g.mitigated);

  // Bullish signals: unmitigated bull FVGs below price = support structure
  //                  unmitigated bear FVGs below price = price above resistance (bullish)
  // Bearish signals: unmitigated bear FVGs above price = overhead resistance
  //                  unmitigated bull FVGs above price = price below support (bearish)
  const bullSupport   = unmitigated.filter(g => g.type === 'BULL' && g.hi < spot).length;
  const bearResist    = unmitigated.filter(g => g.type === 'BEAR' && g.lo > spot).length;
  const bearSupport   = unmitigated.filter(g => g.type === 'BEAR' && g.hi < spot).length; // price above = bullish
  const bullResist    = unmitigated.filter(g => g.type === 'BULL' && g.lo > spot).length; // price below = bearish

  // Net: (bullish structure) - (bearish overhead)
  const net = (bullSupport + bearSupport) - (bearResist + bullResist);
  const score = Math.max(-10, Math.min(10, net * 1.5));

  // Find nearest gaps for key level display
  const nearestBullFVG = unmitigated.filter(g => g.type === 'BULL').sort((a, b) => Math.abs(a.mid - spot) - Math.abs(b.mid - spot))[0];
  const nearestBearFVG = unmitigated.filter(g => g.type === 'BEAR').sort((a, b) => Math.abs(a.mid - spot) - Math.abs(b.mid - spot))[0];

  return {
    score,
    gaps: gaps.slice(-20),          // last 20 for display
    unmitigated,
    bullSupport, bearResist,
    activeCount: unmitigated.length,
    nearestBullFVG,
    nearestBearFVG,
    interpretation: score > 2 ? 'BULL_FVG_STRUCTURE' : score < -2 ? 'BEAR_FVG_OVERHEAD' : 'NEUTRAL_FVG',
  };
}

// ── Overnight/Globex Gap Signal ───────────────────────────────────────────────
// For futures (ES, NQ): the overnight session is a key context signal.
// Uses daily bars to approximate overnight gap (today's open vs yesterday's close).
// Gap > 0.3% = directional overnight bias; strong gap with follow-through = momentum.
function overnightGapSignal(bars) {
  if (bars.length < 3) return { score: 0, gap: 0, type: 'NO_DATA' };

  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  // Overnight gap: today's open vs yesterday's close
  const gap     = (curr.open - prev.close) / prev.close;
  const thresh  = 0.003; // 0.3%

  // Gap fill: did price come back to fill the overnight gap?
  const gapFilled = gap > 0
    ? curr.low  <= prev.close   // bull gap, price came back to fill
    : curr.high >= prev.close;  // bear gap, price came back to fill

  // Continuation: price moved further in the gap direction from open
  const continued = gap > 0
    ? curr.close > curr.open    // bull gap + green candle = continuation
    : curr.close < curr.open;   // bear gap + red candle = continuation

  let score = 0, type = 'FLAT_OPEN';

  if (Math.abs(gap) > thresh) {
    const dir = gap > 0 ? 1 : -1;
    const magnitude = Math.min(Math.abs(gap) / 0.008, 1); // cap at 0.8%
    const base = dir * magnitude * 6;

    if (!gapFilled && continued) {
      score = base * 1.2;
      type  = gap > 0 ? 'GAP_UP_CONTINUATION' : 'GAP_DOWN_CONTINUATION';
    } else if (!gapFilled) {
      score = base * 0.6;
      type  = gap > 0 ? 'GAP_UP_OPEN' : 'GAP_DOWN_OPEN';
    } else {
      // Gap filled = mean reversion underway, fade the gap direction
      score = -dir * magnitude * 3;
      type  = 'GAP_FILLED';
    }
  }

  return {
    score: Math.max(-10, Math.min(10, score)),
    gap,
    gapPct: gap * 100,
    gapFilled,
    continued,
    type,
    prevClose: prev.close,
    openPrice: curr.open,
  };
}

// ── Psychological Round Number Levels ─────────────────────────────────────────
// Round numbers act as support/resistance (Harris 1991, Donaldson & Kim 1993).
// For ES: spacing = 50pts; for NQ: spacing = 250pts; equity: 5% of price
function computeRoundLevels(spot, symbol = '') {
  const isFutures = symbol.includes('=F');
  const isNQ = symbol.includes('NQ');
  const isES = symbol.includes('ES') || symbol === 'SPY';

  let spacing = spot * 0.05;           // default: 5% intervals
  if (isNQ) spacing = 250;             // NQ: every 250 pts
  else if (isES) spacing = 50;         // ES: every 50 pts
  else if (spot > 1000) spacing = 100; // high-priced futures

  const base = Math.round(spot / spacing) * spacing;
  const levels = [];
  for (let i = -4; i <= 4; i++) {
    const price = base + i * spacing;
    if (price <= 0) continue;
    const dist = (price - spot) / spot * 100;
    levels.push({
      price: +price.toFixed(2),
      type: 'ROUND_NUMBER',
      label: `${price % (spacing * 2) === 0 ? '★ ' : ''}${price}`,
      distPct: +dist.toFixed(2),
      isMajor: price % (spacing * 4) === 0,
    });
  }

  return levels.sort((a, b) => a.price - b.price);
}

module.exports = {
  tsmomSignal,
  crossAssetMomentum,
  pdhPdlScore,
  emaStackScore,
  computeOFI,
  intradayMomentumScore,
  vwapZScore,
  detectFairValueGaps,
  overnightGapSignal,
  computeRoundLevels,
};
