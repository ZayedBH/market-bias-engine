'use strict';

// BSM greeks used by deltaWeightedPCRSignal — required at module level (cached by Node)
const { greeks: _bsGreeks } = require('./blackScholes');
const RISK_FREE_DPCR = 0.053; // same fed-funds rate constant as gex.js

// ── Advanced Signal Library ───────────────────────────────────────────────────
// Nine research-backed quantitative concepts for ES/NQ intraday & daily bias.
//
// 1. Opening Range Breakout  (ORB)           — Toby Crabel (1990)
// 2. Standard Error Channel  (LinReg Bands)  — Raff Channel / Donchian
// 3. GARCH(1,1) Volatility Clustering        — Bollerslev (1986)
// 4. Entropy  (Shannon + Permutation)        — Bandt & Pompe (2002)
// 5. Z-Score Mean Reversion  (rolling)       — complement to OU process
// 6. Volume-Price Analysis  (VPA Divergence) — Wyckoff / Williams
// 7. Intraday Time-of-Day Seasonality        — Admati & Pfleiderer (1988)
// 8. Markov Regime Switching Model  (MRSM)   — Hamilton (1989)
// 9. Post-News Behavior  (econ calendar)     — practitioner knowledge
//
// All scores on the [-10, +10] scale:  + = bullish, - = bearish.
// Scores are atan-softened to avoid hard clamping.

// ── Utility ───────────────────────────────────────────────────────────────────
const atan10 = (x, k) => (2 / Math.PI) * Math.atan(x / k) * 10; // [-10,+10]
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ET offset from UTC in hours.  EDT = -4 (Mar–Nov), EST = -5 (Nov–Mar).
// Approximate: check whether DST is active for a given timestamp.
function etOffsetHours(ts) {
  // DST in US: second Sunday March → first Sunday November
  const d  = new Date(ts * 1000);
  const yr = d.getUTCFullYear();

  // Second Sunday in March
  const marchStart = new Date(Date.UTC(yr, 2, 1));
  const marchDay   = marchStart.getUTCDay(); // 0=Sun
  const dstStart   = new Date(Date.UTC(yr, 2, 8 + (7 - marchDay) % 7, 7)); // 2 AM ET = 7 UTC

  // First Sunday in November
  const novStart = new Date(Date.UTC(yr, 10, 1));
  const novDay   = novStart.getUTCDay();
  const dstEnd   = new Date(Date.UTC(yr, 10, 1 + (7 - novDay) % 7, 6)); // 2 AM ET = 6 UTC

  return (d >= dstStart && d < dstEnd) ? -4 : -5;
}

// Return { hh, mm, decimalHour, dayOfWeek, dayOfMonth } in ET for a Unix timestamp (seconds)
function toET(ts) {
  const offsetMs = etOffsetHours(ts) * 3600 * 1000;
  const d        = new Date(ts * 1000 + offsetMs);
  return {
    hh:           d.getUTCHours(),
    mm:           d.getUTCMinutes(),
    decimalHour:  d.getUTCHours() + d.getUTCMinutes() / 60,
    dayOfWeek:    d.getUTCDay(),    // 0=Sun
    dayOfMonth:   d.getUTCDate(),
    iso:          d.toISOString().slice(0, 16) + ' ET',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. OPENING RANGE BREAKOUT (ORB)
// ─────────────────────────────────────────────────────────────────────────────
// Crabel (1990): the opening range (first 30 min of RTH) is the single most
// watched intraday reference for ES/NQ traders.
// Above ORB high  → bullish breakout  (+5 to +10)
// Below ORB low   → bearish breakdown (-5 to -10)
// Inside ORB      → consolidation bias by position within range (-2 to +2)
//
// Accepts 5-minute bars with { ts, open, high, low, close, volume } fields.
// Returns { score:0, available:false } when intraday bars are not provided.

function openingRangeSignal(bars5m) {
  if (!bars5m || bars5m.length < 6) {
    return { score: 0, available: false, detail: 'No 5m data' };
  }

  // Find the most recent RTH session date in ET
  const latestTs  = bars5m[bars5m.length - 1].ts;
  const latestET  = toET(latestTs);
  const offset    = etOffsetHours(latestTs) * 3600 * 1000;
  const sessionDateStr = new Date(latestTs * 1000 + offset).toISOString().slice(0, 10);

  // Collect all bars from today's session
  const todayBars = bars5m.filter(b => {
    const d = new Date(b.ts * 1000 + offset);
    return d.toISOString().slice(0, 10) === sessionDateStr;
  });

  if (todayBars.length < 3) {
    return { score: 0, available: false, detail: 'Not enough bars today' };
  }

  // Opening Range = bars in [9:30, 10:00) ET
  const orbBars = todayBars.filter(b => {
    const { decimalHour } = toET(b.ts);
    return decimalHour >= 9.5 && decimalHour < 10.0;
  });

  // If we cannot isolate the ORB window (pre-market data only, or missing window),
  // fall back to the first 6 bars of the session as the "opening range"
  const usedBars = orbBars.length >= 2 ? orbBars : todayBars.slice(0, 6);
  if (!usedBars.length) return { score: 0, available: false, detail: 'ORB window empty' };

  const orbHigh  = Math.max(...usedBars.map(b => b.high));
  const orbLow   = Math.min(...usedBars.map(b => b.low));
  const orbRange = orbHigh - orbLow;
  if (orbRange <= 0) return { score: 0, available: false, detail: 'Zero ORB range' };

  const spot = todayBars[todayBars.length - 1].close;
  const orbMid = (orbHigh + orbLow) / 2;

  let score, detail;
  if (spot > orbHigh) {
    // Bullish breakout — score scales with extension
    const ext  = (spot - orbHigh) / orbRange;
    score  = clamp(5 + atan10(ext, 0.5) * 0.5, 3, 10);
    detail = `ORB BULL breakout (+${(ext * 100).toFixed(0)}% ext) | ORB ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)}`;
  } else if (spot < orbLow) {
    // Bearish breakdown
    const ext  = (orbLow - spot) / orbRange;
    score  = clamp(-(5 + atan10(ext, 0.5) * 0.5), -10, -3);
    detail = `ORB BEAR breakdown (-${(ext * 100).toFixed(0)}% ext) | ORB ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)}`;
  } else {
    // Inside ORB: mild directional bias by position in range
    const pos  = (spot - orbLow) / orbRange; // 0=at low, 1=at high
    score  = (pos - 0.5) * 4;
    detail = `Inside ORB (${(pos * 100).toFixed(0)}%) | ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)}`;
  }

  return {
    score:    clamp(score, -10, 10),
    available: true,
    orbHigh,
    orbLow,
    orbRange,
    spot,
    detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. STANDARD ERROR CHANNEL (Linear Regression Bands)
// ─────────────────────────────────────────────────────────────────────────────
// Fit an OLS trend line to the last `period` closes.  Residuals define the
// standard error (SE).  Signal blends:
//   • Slope signal  → trend direction (positive slope = bullish)
//   • Channel signal → mean reversion when price is outside ±1 SE
// The blend is dynamic: inside ±1 SE, trend dominates; outside, MR dominates.

function standardErrorChannel(closes, period = 50) {
  if (closes.length < period + 5) {
    return { score: 0, available: false, detail: 'Insufficient data' };
  }

  const slice = closes.slice(-period);
  const n     = slice.length;
  const xMean = (n - 1) / 2;
  const yMean = slice.reduce((s, v) => s + v, 0) / n;

  let ssXX = 0, ssXY = 0;
  for (let i = 0; i < n; i++) {
    ssXX += (i - xMean) ** 2;
    ssXY += (i - xMean) * (slice[i] - yMean);
  }

  const slope     = ssXX > 0 ? ssXY / ssXX : 0;
  const intercept = yMean - slope * xMean;

  // Residuals and standard error (unbiased: divide by n-2)
  const residuals  = slice.map((y, i) => y - (intercept + slope * i));
  const se         = Math.sqrt(residuals.reduce((s, r) => s + r ** 2, 0) / Math.max(n - 2, 1));

  // Current bar
  const fit            = intercept + slope * (n - 1);
  const currentResid   = closes[closes.length - 1] - fit;
  const channelZ       = se > 0 ? currentResid / se : 0;

  // Annualised percentage slope
  const slopePctYr     = slope / yMean * 252 * 100;
  const trendScore     = atan10(slopePctYr, 40);  // 40%/yr → ±7.5

  // Mean-reversion score: invert channelZ (>0 = above fit = overbought → bearish)
  const mrScore        = atan10(-channelZ, 1.5);   // z=1.5 → ±7.4

  // Dynamic blend: trend dominant inside channel, MR dominant outside
  const absZ           = Math.abs(channelZ);
  const trendW         = clamp(1 - absZ / 1.5, 0, 1);
  const mrW            = clamp(absZ / 1.5, 0, 1);
  const score          = trendScore * trendW + mrScore * mrW;

  const channelPos = channelZ >  2 ? 'ABOVE 2SE (overbought)'
                   : channelZ >  1 ? 'ABOVE 1SE'
                   : channelZ < -2 ? 'BELOW 2SE (oversold)'
                   : channelZ < -1 ? 'BELOW 1SE'
                   : 'WITHIN CHANNEL';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    slope,
    slopePctYr,
    channelZ,
    se,
    fit,
    channelPos,
    detail:    `${channelPos} z=${channelZ.toFixed(2)} slope=${slopePctYr.toFixed(1)}%/yr`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GARCH(1,1) VOLATILITY CLUSTERING
// ─────────────────────────────────────────────────────────────────────────────
// Bollerslev (1986):  h_t = ω + α·r²_{t-1} + β·h_{t-1}
// Parameters α=0.10, β=0.85 are well-known empirical values for equity index
// (Engle & Ng 1993).  We use variance targeting: ω = σ̄²(1-α-β).
//
// Signal: compares GARCH forecast vol to recent 20-day realised vol.
//   GARCH > realised → vol expansion expected → uncertainty → bearish tilt
//   GARCH < realised → vol contraction (mean reversion) → calmer → bullish tilt
//
// We also expose `forecastVolPct` as a risk management output.

function garchVolatilitySignal(closes) {
  if (closes.length < 60) {
    return { score: 0, available: false, detail: 'Insufficient data for GARCH' };
  }

  // Daily log returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const T          = returns.length;
  const alpha      = 0.10;
  const beta       = 0.85;
  const sampleVar  = returns.reduce((s, r) => s + r * r, 0) / T;
  const omega      = sampleVar * (1 - alpha - beta);   // variance targeting

  // Iterate GARCH(1,1) forward
  // Loop i=1..T-1 updates through r_{T-2}. One more step includes today's return r_{T-1}
  // so h is the one-step-ahead forecast (h_{T+1}) not the stale h_T.
  let h = sampleVar;
  for (let i = 1; i < T; i++) {
    h = omega + alpha * returns[i - 1] ** 2 + beta * h;
  }
  h = omega + alpha * returns[T - 1] ** 2 + beta * h; // include today's return
  h = Math.max(h, 1e-10);

  const garchForecastVol = Math.sqrt(h * 252) * 100;  // annualised %

  // 20-day realised vol for comparison
  const window20 = returns.slice(-20);
  const realVol  = Math.sqrt(window20.reduce((s, r) => s + r * r, 0) / 20 * 252) * 100;

  // Long-run unconditional vol
  const longRunVol = Math.sqrt(sampleVar * 252) * 100;

  // Signals
  const volRatio   = garchForecastVol / (realVol + 0.1);
  // Vol expanding → uncertainty premium → bearish; contracting → calm → bullish
  const score      = atan10(-(volRatio - 1), 0.35);

  // Also flag whether GARCH forecast is above the long-run average (regime signal)
  const vsLongRun  = garchForecastVol / (longRunVol + 0.1);
  const regime     = volRatio > 1.3  ? 'VOL_EXPANDING'
                   : volRatio < 0.75 ? 'VOL_CONTRACTING'
                   : vsLongRun > 1.2 ? 'ELEVATED_REGIME'
                   : 'VOL_STABLE';

  return {
    score:            clamp(score, -10, 10),
    available:        true,
    garchForecastVol: +garchForecastVol.toFixed(2),
    realVol:          +realVol.toFixed(2),
    longRunVol:       +longRunVol.toFixed(2),
    volRatio:         +volRatio.toFixed(3),
    regime,
    detail: `GARCH ${garchForecastVol.toFixed(1)}% vs 20d ${realVol.toFixed(1)}% → ${regime}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ENTROPY  (Shannon + Permutation)
// ─────────────────────────────────────────────────────────────────────────────
// Shannon entropy of the return distribution (Bin, 2006) measures how uniformly
// spread returns are — high entropy = unpredictable / chaotic market.
// Permutation entropy (Bandt & Pompe 2002) captures the complexity of the
// ordinal-pattern structure in the price series.
//
// Signal interpretation:
//   Low entropy   → orderly, trending market → slight positive (clarity premium)
//   High entropy  → chaotic, uncertain market → slight negative (uncertainty)
// Primary use: as a confidence multiplier that can be read by bias.js to
// down-weight all other signals when entropy is high.

function _shannonEntropy(values, bins = 20) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0;
  const w     = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[clamp(Math.floor((v - min) / w), 0, bins - 1)]++;
  const n = values.length;
  let H = 0;
  for (const c of counts) {
    if (c > 0) { const p = c / n; H -= p * Math.log2(p); }
  }
  return H / Math.log2(bins);  // normalised [0,1]
}

function _factorial(n) {
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

function _permutationEntropy(series, order = 4, delay = 1) {
  const patterns = new Map();
  let total = 0;
  for (let i = 0; i + (order - 1) * delay < series.length; i++) {
    const window = Array.from({ length: order }, (_, j) => ({ v: series[i + j * delay], j }));
    window.sort((a, b) => a.v - b.v || a.j - b.j);
    const key = window.map(w => w.j).join(',');
    patterns.set(key, (patterns.get(key) ?? 0) + 1);
    total++;
  }
  let H = 0;
  for (const c of patterns.values()) {
    const p = c / total;
    H -= p * Math.log2(p);
  }
  const maxH = Math.log2(_factorial(order));
  return maxH > 0 ? H / maxH : 0;  // normalised [0,1]
}

function entropySignal(closes) {
  if (closes.length < 60) {
    return { score: 0, available: false, detail: 'Insufficient data for entropy' };
  }

  const recentCloses  = closes.slice(-100);
  const returns       = [];
  for (let i = 1; i < recentCloses.length; i++) {
    returns.push(Math.log(recentCloses[i] / recentCloses[i - 1]));
  }

  const se  = _shannonEntropy(returns, 20);       // return distribution entropy
  const pe  = _permutationEntropy(recentCloses, 4, 1);  // ordinal complexity

  const combined = (se + pe) / 2;  // [0,1]

  // atan-scale: entropy=0.2 → +5 (orderly), entropy=0.8 → -5 (chaotic)
  const score = atan10(-(combined - 0.5), 0.15);

  const regime = combined < 0.35 ? 'LOW_ENTROPY'
               : combined < 0.60 ? 'MODERATE_ENTROPY'
               : 'HIGH_ENTROPY';

  // signalConfidenceMultiplier: 1.0 when entropy is very low, 0.55 at maximum entropy
  // bias.js can use this to scale down all other signal weights in chaotic markets
  const signalConfidenceMultiplier = 1.0 - combined * 0.45;

  return {
    score:                     clamp(score, -10, 10),
    available:                 true,
    shannonEntropy:            +se.toFixed(3),
    permEntropy:               +pe.toFixed(3),
    combined:                  +combined.toFixed(3),
    signalConfidenceMultiplier: +signalConfidenceMultiplier.toFixed(3),
    regime,
    detail: `SE=${se.toFixed(2)} PE=${pe.toFixed(2)} → ${regime}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Z-SCORE MEAN REVERSION (rolling)
// ─────────────────────────────────────────────────────────────────────────────
// Rolling z-score of spot vs 20-day mean and std.
// Complements the OU process (which fits a continuous-time model) with a simpler
// but more directly interpretable discrete-time price z-score.
// z > 0 = above mean → mean reversion bearish; z < 0 = below mean → bullish.

function zScoreMeanReversion(closes, period = 20) {
  if (closes.length < period + 5) {
    return { score: 0, available: false, detail: 'Insufficient data for z-score' };
  }

  const slice  = closes.slice(-period);
  const mean   = slice.reduce((s, v) => s + v, 0) / period;
  const std    = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const spot   = closes[closes.length - 1];
  const zScore = std > 0 ? (spot - mean) / std : 0;

  // Invert: high z = bearish, low z = bullish
  const score  = atan10(-zScore, 1.0);  // z=1 → ±7.4, z=2 → ±9.2

  const regime = zScore >  2 ? 'OVERBOUGHT'
               : zScore >  1 ? 'ELEVATED'
               : zScore < -2 ? 'OVERSOLD'
               : zScore < -1 ? 'DEPRESSED'
               : 'AT_MEAN';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    zScore:    +zScore.toFixed(3),
    mean:      +mean.toFixed(4),
    std:       +std.toFixed(4),
    regime,
    detail:    `z=${zScore.toFixed(2)} vs ${period}d mean=${mean.toFixed(2)} → ${regime}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. VOLUME PRICE ANALYSIS (VPA / Wyckoff Divergence)
// ─────────────────────────────────────────────────────────────────────────────
// Wyckoff's volume-spread analysis: the relationship between the price range
// (spread), close position within the bar, and volume reveals institutional
// intent.  Bullish signals: up-bars on expanding volume; weakness on no-demand
// (up-bar, narrow spread, low volume) or shakeout (down-bar, narrow spread,
// low volume – sells exhausted).
//
// Signal categories:
//   BULLISH CONFIRMATION  : price up, volume above average           (+)
//   BEARISH DIVERGENCE    : price up, volume below average           (−)
//   DISTRIBUTION          : price down, volume above average,        (−)
//                           close near low of bar
//   ABSORPTION/CLIMAX     : price down, volume above average,        (+)
//                           close near HIGH of bar (buyers absorbing)
//   WEAK SELLING          : price down, volume below average         (+)
//   NEUTRAL               : small price move                         (0)

function vpaDivergence(bars, period = 20) {
  const validBars = bars.filter(b => b.volume != null && b.volume > 0 && b.high != null && b.low != null);
  if (validBars.length < period + 3) {
    return { score: 0, available: false, detail: 'No volume data' };
  }

  // Average volume over `period` bars (excluding most recent)
  const avgVol = validBars.slice(-(period + 1), -1)
    .reduce((s, b) => s + b.volume, 0) / period;

  if (avgVol === 0) return { score: 0, available: false, detail: 'Zero avg volume' };

  // Analyse the last 5 bars for cumulative divergence
  const lookback   = Math.min(5, validBars.length - 1);
  const window     = validBars.slice(-lookback - 1);
  let cumulScore   = 0;
  const signals    = [];

  for (let i = 1; i < window.length; i++) {
    const prev       = window[i - 1];
    const curr       = window[i];
    const priceChg   = curr.close - prev.close;
    const barRange   = Math.max(curr.high - curr.low, 1e-6);
    const closePos   = (curr.close - curr.low) / barRange;  // 0 = at low, 1 = at high
    const volRatio   = curr.volume / avgVol;
    const isUp       = priceChg > 0;
    const isHighVol  = volRatio > 1.2;
    const isLowVol   = volRatio < 0.8;
    const significant = Math.abs(priceChg) / prev.close > 0.001;

    if (!significant) { signals.push('NARROW_RANGE'); continue; }

    if (isUp && isHighVol) {
      const w = Math.min(volRatio, 2.5);
      cumulScore += 2.0 * w;
      signals.push('BULLISH CONFIRMATION');
    } else if (isUp && isLowVol) {
      cumulScore -= 1.5;
      signals.push('BEARISH DIVERGENCE (weak demand)');
    } else if (!isUp && isHighVol) {
      if (closePos > 0.6) {
        // Buyers absorbing selling — potential climax
        cumulScore += 1.5;
        signals.push('ABSORPTION/CLIMAX (bullish)');
      } else {
        // Distribution: close near lows on heavy selling
        const w = Math.min(volRatio, 2.5);
        cumulScore -= 2.0 * w;
        signals.push('DISTRIBUTION (bearish)');
      }
    } else if (!isUp && isLowVol) {
      // No supply — selling drying up (Wyckoff bullish)
      cumulScore += 1.5;
      signals.push('WEAK SELLING (no supply)');
    } else {
      signals.push('NEUTRAL');
    }
  }

  const maxPossible = lookback * 5;  // ~5 per bar maximum
  const score       = atan10(cumulScore, maxPossible / 3);

  const dominantSignal = signals.filter(s => s !== 'NEUTRAL' && s !== 'NARROW_RANGE').at(-1) ?? 'NEUTRAL';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    signals,
    cumulScore,
    dominantSignal,
    avgVol:    Math.round(avgVol),
    detail:    dominantSignal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. INTRADAY TIME-OF-DAY SEASONALITY
// ─────────────────────────────────────────────────────────────────────────────
// ES/NQ exhibit well-documented intraday patterns (Admati & Pfleiderer 1988;
// Jain & Joh 1988).  These are directional biases INDEPENDENT of current price:
//
//   09:30–10:00  Opening Burst   — high vol, follow-through tendency   (+)
//   10:00–11:30  Post-Open Fade  — initial move often reverts 50–100%  (−)
//   11:30–13:00  Lunch Doldrums  — low vol, fakeout prone              (−)
//   13:00–14:30  Afternoon Drift — directional continuation resumes    (+)
//   14:30–15:00  Pre-Power Hour  — mixed; news window (FOMC)           (0)
//   15:00–15:30  Power Hour      — strongest trend continuation        (+)
//   15:30–16:15  MOC Window      — index rebalancing, forced flow      (+)
//   18:00–09:30  Globex/Overnight— thin liquidity, mean-drift           (−)
//
// Accepts an optional timestamp (Unix seconds).  Falls back to system clock.

function intradaySeasonality(nowTs) {
  const ts = nowTs ?? Math.floor(Date.now() / 1000);
  const et = toET(ts);
  const t  = et.decimalHour;

  let score, period;

  if      (t >= 9.5   && t < 10.0)  { score =  2.0; period = 'OPENING BURST (9:30–10:00)'  }
  else if (t >= 10.0  && t < 11.5)  { score = -0.5; period = 'POST-OPEN FADE (10:00–11:30)' }
  else if (t >= 11.5  && t < 13.0)  { score = -1.0; period = 'LUNCH DOLDRUMS (11:30–13:00)' }
  else if (t >= 13.0  && t < 14.5)  { score =  1.0; period = 'AFTERNOON DRIFT (13:00–14:30)'}
  else if (t >= 14.5  && t < 15.0)  { score =  0.5; period = 'PRE-POWER HOUR (14:30–15:00)' }
  else if (t >= 15.0  && t < 15.5)  { score =  2.5; period = 'POWER HOUR (15:00–15:30)'     }
  else if (t >= 15.5  && t < 16.25) { score =  1.0; period = 'MOC WINDOW (15:30–16:15)'     }
  else if (t >= 16.25 && t < 18.0)  { score =  0.0; period = 'POST-CLOSE'                   }
  else if (t >= 18.0  || t <  4.0)  { score = -0.5; period = 'GLOBEX OVERNIGHT'             }
  else                               { score =  0.0; period = 'PRE-MARKET (04:00–09:30)'     }

  return {
    score:     clamp(score, -10, 10),
    available: true,
    period,
    timeET:    `${String(et.hh).padStart(2,'0')}:${String(et.mm).padStart(2,'0')} ET`,
    detail:    period,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. MARKOV REGIME SWITCHING MODEL (MRSM / Hamilton 1989)
// ─────────────────────────────────────────────────────────────────────────────
// Two-state Gaussian mixture with hidden Markov transitions.
// Returns are split between:
//   State 0 (bull): higher mean, lower variance
//   State 1 (bear): lower mean, higher variance
// The EM algorithm (Baum-Welch) estimates parameters and filtered probabilities.
// Unlike the HMM in regime.js (which uses multivariate price features),
// MRSM operates directly on the return distribution — complementary information.
//
// Seeded initialisation prevents label flipping across calls.

const _mrsmCache = new Map();
const MRSM_TTL   = 5 * 60 * 1000;  // 5-min cache (matches server bias TTL)

function mrsmSignal(closes) {
  if (closes.length < 80) {
    return { score: 0, available: false, detail: 'Insufficient data for MRSM' };
  }

  // Cache key: symbol is not passed here; use last-close + length as proxy
  const cacheKey = `${closes.length}:${closes[closes.length - 1].toFixed(4)}`;
  const hit      = _mrsmCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < MRSM_TTL) return hit.result;

  // Log returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const T  = returns.length;
  const K  = 2;

  // Initialise parameters (variance-based initialisation for equity regime)
  const mean  = returns.reduce((s, r) => s + r, 0) / T;
  const std   = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / T);

  // State 0 = bull (above-average mean, lower vol)
  // State 1 = bear (below-average mean, higher vol)
  let mu    = [mean + 0.3 * std, mean - 0.3 * std];
  let sigma = [std * 0.7,        std * 1.5];
  let A     = [[0.95, 0.05], [0.10, 0.90]];  // persistent regimes
  let pi    = [0.7, 0.3];

  const gaussPDF = (x, m, s) => {
    if (s < 1e-9) return 1e-300;
    return Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
  };

  // EM iterations (Baum-Welch)
  const MAX_ITER = 60;
  const TOL      = 1e-5;
  let prevLL     = -Infinity;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // ── E-step: forward-backward in log scale ──────────────────────────────
    // Emission log-probabilities
    const logB = returns.map(r =>
      [Math.log(gaussPDF(r, mu[0], sigma[0]) + 1e-300),
       Math.log(gaussPDF(r, mu[1], sigma[1]) + 1e-300)]
    );

    // Forward pass (log scale)
    const logAlpha = Array.from({ length: T }, () => [0, 0]);
    logAlpha[0][0] = Math.log(pi[0] + 1e-300) + logB[0][0];
    logAlpha[0][1] = Math.log(pi[1] + 1e-300) + logB[0][1];

    for (let t = 1; t < T; t++) {
      for (let j = 0; j < K; j++) {
        const candidates = [
          logAlpha[t-1][0] + Math.log(A[0][j] + 1e-300),
          logAlpha[t-1][1] + Math.log(A[1][j] + 1e-300),
        ];
        const m     = Math.max(...candidates);
        const lse   = m + Math.log(candidates.reduce((s, v) => s + Math.exp(v - m), 0));
        logAlpha[t][j] = lse + logB[t][j];
      }
    }

    // Log-likelihood
    const lastAlpha = logAlpha[T - 1];
    const maxLA     = Math.max(...lastAlpha);
    const logLik    = maxLA + Math.log(lastAlpha.reduce((s, v) => s + Math.exp(v - maxLA), 0));

    // Backward pass
    const logBeta = Array.from({ length: T }, () => [0.0, 0.0]);
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < K; i++) {
        const candidates = [
          Math.log(A[i][0] + 1e-300) + logB[t+1][0] + logBeta[t+1][0],
          Math.log(A[i][1] + 1e-300) + logB[t+1][1] + logBeta[t+1][1],
        ];
        const m   = Math.max(...candidates);
        const lse = m + Math.log(candidates.reduce((s, v) => s + Math.exp(v - m), 0));
        logBeta[t][i] = lse;
      }
    }

    // Gamma (posterior state probabilities)
    const gamma = Array.from({ length: T }, (_, t) => {
      const log0 = logAlpha[t][0] + logBeta[t][0];
      const log1 = logAlpha[t][1] + logBeta[t][1];
      const m    = Math.max(log0, log1);
      const p0   = Math.exp(log0 - m);
      const p1   = Math.exp(log1 - m);
      const tot  = p0 + p1;
      return [p0 / tot, p1 / tot];
    });

    // Xi (transition posteriors)
    const xi = Array.from({ length: T - 1 }, (_, t) => {
      const mat = [[0, 0], [0, 0]];
      let tot   = 0;
      for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
          const v = Math.exp(
            logAlpha[t][i] + Math.log(A[i][j] + 1e-300) +
            logB[t+1][j] + logBeta[t+1][j] - logLik
          );
          mat[i][j] = isFinite(v) ? v : 0;
          tot       += mat[i][j];
        }
      }
      if (tot > 1e-9) {
        for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) mat[i][j] /= tot;
      }
      return mat;
    });

    // ── M-step: update parameters ──────────────────────────────────────────
    for (let k = 0; k < K; k++) {
      const gSum = gamma.reduce((s, g) => s + g[k], 0);
      if (gSum > 1e-9) {
        mu[k]    = gamma.reduce((s, g, t) => s + g[k] * returns[t], 0) / gSum;
        sigma[k] = Math.sqrt(
          Math.max(1e-8, gamma.reduce((s, g, t) => s + g[k] * (returns[t] - mu[k]) ** 2, 0) / gSum)
        );
      }
    }

    for (let i = 0; i < K; i++) {
      const xiSum = xi.reduce((s, x) => s + x[i][0] + x[i][1], 0);
      for (let j = 0; j < K; j++) {
        A[i][j] = xiSum > 1e-9 ? xi.reduce((s, x) => s + x[i][j], 0) / xiSum : 0.5;
      }
    }

    pi = [gamma[0][0], gamma[0][1]];

    if (Math.abs(logLik - prevLL) < TOL) break;
    prevLL = logLik;
  }

  // ── Identify bull vs bear state by mean return ──────────────────────────
  const bullState = mu[0] >= mu[1] ? 0 : 1;
  const bearState = 1 - bullState;

  // Last-period smoothed state probabilities (use last few for stability)
  // We re-run just the forward pass for the last observation to get filtered probs
  const logB_last  = [
    Math.log(gaussPDF(returns[T-1], mu[0], sigma[0]) + 1e-300),
    Math.log(gaussPDF(returns[T-1], mu[1], sigma[1]) + 1e-300),
  ];
  // Filtered probability (use smoothed approach: average last 3 gammas)
  const lastGammas = [];
  for (let i = 0; i < K; i++) {
    // Re-compute gamma for last 3 bars via forward-backward
    // We can approximate with the stored last forward probs
    const logA0 = logB_last[i];  // simplified: use emission only
    lastGammas.push(logA0);
  }

  // Compute full gamma for last bar using stored log-likelihoods
  // (already done in last EM iteration — recompute cleanly)
  const finalGamma = (() => {
    const logB_f = returns.map(r =>
      [Math.log(gaussPDF(r, mu[0], sigma[0]) + 1e-300),
       Math.log(gaussPDF(r, mu[1], sigma[1]) + 1e-300)]
    );
    let la = [
      Math.log(pi[0] + 1e-300) + logB_f[0][0],
      Math.log(pi[1] + 1e-300) + logB_f[0][1],
    ];
    for (let t = 1; t < T; t++) {
      const next = [0, 0];
      for (let j = 0; j < K; j++) {
        const cands = [la[0] + Math.log(A[0][j] + 1e-300), la[1] + Math.log(A[1][j] + 1e-300)];
        const m   = Math.max(...cands);
        next[j]   = m + Math.log(cands.reduce((s, v) => s + Math.exp(v - m), 0)) + logB_f[t][j];
      }
      la = next;
    }
    const m   = Math.max(...la);
    const p0  = Math.exp(la[0] - m);
    const p1  = Math.exp(la[1] - m);
    const tot = p0 + p1;
    return [p0 / tot, p1 / tot];
  })();

  const bullProb = finalGamma[bullState];
  const bearProb = finalGamma[bearState];

  // atan-scale: 90% bull → +9, 90% bear → -9, 50/50 → 0
  const score = atan10((bullProb - bearProb), 0.25);

  const regime = bullProb > 0.7 ? 'BULL_REGIME'
               : bearProb > 0.7 ? 'BEAR_REGIME'
               : 'TRANSITION';

  const result = {
    score:     clamp(score, -10, 10),
    available: true,
    bullProb:  +bullProb.toFixed(3),
    bearProb:  +bearProb.toFixed(3),
    bullMu:    +mu[bullState].toFixed(5),
    bearMu:    +mu[bearState].toFixed(5),
    bullSigma: +sigma[bullState].toFixed(5),
    bearSigma: +sigma[bearState].toFixed(5),
    bullA:     +A[bullState][bullState].toFixed(3),  // P(stay bull)
    bearA:     +A[bearState][bearState].toFixed(3),  // P(stay bear)
    regime,
    detail: `MRSM ${regime} bull=${(bullProb*100).toFixed(0)}% bear=${(bearProb*100).toFixed(0)}%`,
  };

  _mrsmCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. POST-NEWS BEHAVIOR
// ─────────────────────────────────────────────────────────────────────────────
// Economic releases create predictable volatility patterns.
// Phase model based on empirical trader observations (Savor & Wilson 2013;
// Lucca & Moench 2015 for FOMC):
//
//   0–15 min post-release   : Immediate volatility, uncertain direction       (−)
//   15–60 min post-release  : Price discovery; initial move tends to continue (+)
//   60–120 min post-release : Potential exhaustion / fade zone                (−)
//   >120 min                : Normal market behaviour restored                 (0)
//
// Without a live economic calendar, we use fixed weekly/daily release windows
// as the best available heuristic.  The signal is deliberately low-weight.

// NOTE: FOMC releases were previously hard-coded to every Wednesday (dayMask:[3])
// which caused false signals on non-FOMC Wednesdays (FOMC meets ~8x/year, not 52x).
// Removed: preEventDriftSignal() now handles FOMC correctly via hard-coded dates.
// postNewsBehavior() covers the generic 8:30 AM / 10:00 AM economic release windows
// that happen on most days and are genuinely hard to calendar precisely.
const RELEASE_WINDOWS = [
  // Time in ET (hour, minute) — releases that happen on MOST of these days/weeks
  { name: '8:30 AM Release',  hour: 8,  min: 30, dayMask: [1,2,3,4,5], impact: 'HIGH'   },  // NFP/CPI/Claims
  { name: '10:00 AM Release', hour: 10, min:  0, dayMask: [1,2,3,4,5], impact: 'MEDIUM' },  // ISM/Housing/Conf
];

function postNewsBehavior(nowTs) {
  const ts = nowTs ?? Math.floor(Date.now() / 1000);
  const et = toET(ts);
  const currentMins = et.hh * 60 + et.mm;

  let closestMinsSince = Infinity;
  let closestImpact    = 'MEDIUM';
  let closestName      = '';

  for (const rel of RELEASE_WINDOWS) {
    if (!rel.dayMask.includes(et.dayOfWeek)) continue;
    const relMins  = rel.hour * 60 + rel.min;
    const minsSince = currentMins - relMins;
    if (minsSince >= 0 && minsSince < closestMinsSince) {
      closestMinsSince = minsSince;
      closestImpact    = rel.impact;
      closestName      = rel.name;
    }
  }

  if (closestMinsSince === Infinity || closestMinsSince > 180) {
    return {
      score:     0,
      available: true,
      regime:   'NO_RECENT_RELEASE',
      detail:   'No high-impact release window active',
    };
  }

  const impMult = closestImpact === 'HIGHEST' ? 2.0 : closestImpact === 'HIGH' ? 1.5 : 1.0;
  let score, regime;

  if (closestMinsSince < 15) {
    score  = clamp(-2.5 * impMult, -10, 0);
    regime = 'IMMEDIATE_VOLATILITY';
  } else if (closestMinsSince < 60) {
    score  = clamp(+1.5 * impMult, 0, 10);
    regime = 'PRICE_DISCOVERY';
  } else if (closestMinsSince < 120) {
    score  = -0.5;
    regime = 'FADE_ZONE';
  } else {
    score  = 0;
    regime = 'NORMALIZED';
  }

  return {
    score:            clamp(score, -10, 10),
    available:        true,
    releaseName:      closestName,
    minsSinceRelease: closestMinsSince,
    impact:           closestImpact,
    regime,
    detail: `${closestName}: ${closestMinsSince.toFixed(0)}min ago → ${regime}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. SKEWNESS & KURTOSIS — Return Distribution Shape Signal
// ─────────────────────────────────────────────────────────────────────────────
// The third and fourth standardised moments of the return distribution reveal
// structural bias and tail risk that the mean and variance alone miss.
//
// SKEWNESS (third moment):
//   • Negative skew  → left tail is fatter than right → crash risk elevated
//     (equity index returns are structurally negatively skewed — put demand)
//   • Positive skew  → right tail dominates → breakout/rally potential
//   • Neutral (≈ 0)  → symmetric distribution, no directional tilt
//
// EXCESS KURTOSIS (fourth moment, Gaussian baseline = 3, so excess = K - 3):
//   • Leptokurtic (K > 0) → fatter tails than Gaussian → extreme moves more likely
//   • Platykurtic (K < 0) → thinner tails → dampened extremes (rare for equity)
//
// COMPOSITE SIGNAL:
//   Combines skewness (directional) and excess kurtosis (amplifier).
//   When skew is strongly negative AND kurtosis is high: tail risk is highest → bearish.
//   When skew is mildly positive and kurtosis is moderate: distribution is improving → bullish.
//
// Uses a rolling 60-day window to capture current distribution shape, not long-run averages.

function _mean(arr)  { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function _moment(arr, mu, n) {
  return arr.reduce((s, v) => s + (v - mu) ** n, 0) / arr.length;
}

function skewnessKurtosisSignal(closes, period = 60) {
  if (closes.length < period + 2) {
    return { score: 0, available: false, detail: 'Insufficient data for moments' };
  }

  // Log returns for the rolling window
  const priceSlice = closes.slice(-(period + 1));
  const returns    = [];
  for (let i = 1; i < priceSlice.length; i++) {
    returns.push(Math.log(priceSlice[i] / priceSlice[i - 1]));
  }

  const n   = returns.length;
  const mu  = _mean(returns);
  const m2  = _moment(returns, mu, 2);   // variance
  const m3  = _moment(returns, mu, 3);
  const m4  = _moment(returns, mu, 4);

  const std          = Math.sqrt(m2);
  const skewness     = std > 1e-10 ? m3 / (std ** 3) : 0;   // standardised
  const rawKurtosis  = std > 1e-10 ? m4 / (std ** 4) : 3;   // raw
  const excessKurt   = rawKurtosis - 3;                       // excess (Gaussian = 0)

  // ── Jarque-Bera normality test statistic ─────────────────────────────────
  // JB = n/6 × (S² + K²/4)  — measures departure from normality
  // Under H₀ (normality): JB ~ χ²(2).  Critical values: 5.99 (p<0.05), 9.21 (p<0.01)
  const jb = (n / 6) * (skewness ** 2 + excessKurt ** 2 / 4);

  // ── Skewness signal (directional): negative skew = left tail risk = bearish ──
  // atan-scale: skew = -1 → -7.4, skew = +1 → +7.4
  const skewScore = atan10(skewness, 0.8);

  // ── Kurtosis amplifier: high excess kurtosis amplifies the skew signal ────
  // Logic: high kurtosis alone doesn't give direction, but with negative skew
  // it makes the left tail much fatter → heightened crash risk → bear amplifier.
  // Standalone kurtosis contribution is small and inverse (high kurtosis = caution).
  const kurtAmplifier = clamp(1 + excessKurt / 5, 0.5, 2.0);   // 1.0 at normal, 2.0 at very fat tails
  const amplifiedSkew  = skewScore * kurtAmplifier;

  // Standalone kurtosis penalty: very high excess kurtosis = elevated volatility risk
  // regardless of direction → slight negative (uncertainty premium)
  const kurtPenalty = atan10(-Math.max(0, excessKurt - 2), 3) * 0.3;  // only kicks in above excess K=2

  const score = clamp(amplifiedSkew + kurtPenalty, -10, 10);

  const skewLabel = skewness < -0.5 ? 'NEG_SKEW (left tail risk)'
                  : skewness >  0.5 ? 'POS_SKEW (right tail)'
                  : 'SYMMETRIC';
  const kurtLabel = excessKurt >  2 ? 'FAT_TAILS'
                  : excessKurt >  0 ? 'MILD_FAT_TAILS'
                  : 'THIN_TAILS';
  const nonNormal = jb > 9.21 ? 'HIGHLY_NON-NORMAL' : jb > 5.99 ? 'NON-NORMAL' : 'APPROX_NORMAL';

  return {
    score,
    available:   true,
    skewness:    +skewness.toFixed(4),
    excessKurt:  +excessKurt.toFixed(4),
    rawKurtosis: +rawKurtosis.toFixed(4),
    jb:          +jb.toFixed(2),
    skewLabel,
    kurtLabel,
    nonNormal,
    detail: `S=${skewness.toFixed(2)} K=${excessKurt.toFixed(2)} (${skewLabel.split(' ')[0]} / ${kurtLabel})`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. FAT TAILS — Empirical vs Gaussian Tail Comparison
// ─────────────────────────────────────────────────────────────────────────────
// Fat tails (leptokurtosis) mean that extreme events happen far more often than
// a Gaussian model predicts.  For ES/NQ this is the core risk reality:
// Mandelbrot (1963) showed equity returns follow power laws, not Gaussians.
//
// This signal computes the EMPIRICAL tail vs what a fitted Gaussian predicts
// at the 5th and 1st percentile.  If the empirical left tail is much worse:
//   → crash risk is elevated above what vol-targeting models assume → BEARISH
//
// Also computes the TAIL RATIO: right tail 95th percentile / abs(left tail 5th).
// Tail ratio > 1 → right tail larger → positively skewed environment → BULLISH
// Tail ratio < 1 → left tail dominant → crash-prone environment → BEARISH
//
// Power-law tail index (Hill estimator) provides the heaviness of the tail.
// α < 3: variance may not exist; α < 2: mean may not exist (very fat tail).

function fatTailsSignal(closes, period = 120) {
  if (closes.length < period + 2) {
    return { score: 0, available: false, detail: 'Insufficient data for tail analysis' };
  }

  const priceSlice = closes.slice(-(period + 1));
  const returns    = [];
  for (let i = 1; i < priceSlice.length; i++) {
    returns.push(Math.log(priceSlice[i] / priceSlice[i - 1]));
  }

  const n      = returns.length;
  const sorted = [...returns].sort((a, b) => a - b);   // ascending
  const mu     = _mean(returns);
  const sigma  = Math.sqrt(_moment(returns, mu, 2));

  // ── Empirical percentiles ─────────────────────────────────────────────────
  const pct = (p) => {
    const idx = p * (n - 1);
    const lo  = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  const emp5th   = pct(0.05);   // empirical 5th percentile (left tail)
  const emp1st   = pct(0.01);   // empirical 1st percentile (very left tail)
  const emp95th  = pct(0.95);   // empirical 95th percentile (right tail)
  const emp99th  = pct(0.99);   // empirical 99th percentile (very right tail)

  // ── Gaussian predictions at same percentiles ──────────────────────────────
  // Inverse normal CDF approximation (Beasley-Springer-Moro)
  const invNorm = (p) => {
    const a = [0, -3.969683028665376e+01, 2.209460984245205e+02,
      -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [0, -5.447609879822406e+01, 1.615858368580409e+02,
      -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pLow = 0.02425, pHigh = 1 - pLow;
    let x;
    if (p < pLow) {
      const q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
          ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    } else if (p <= pHigh) {
      const q = p - 0.5, r = q * q;
      x = (((((a[1]*r+a[2])*r+a[3])*r+a[4])*r+a[5])*r+a[6])*q /
          (((((b[1]*r+b[2])*r+b[3])*r+b[4])*r+b[5])*r+1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
    return mu + sigma * x;
  };

  const gauss5th  = invNorm(0.05);
  const gauss1st  = invNorm(0.01);
  const gauss95th = invNorm(0.95);
  const gauss99th = invNorm(0.99);

  // ── Tail excess ratios ────────────────────────────────────────────────────
  // Left tail: emp is MORE negative than Gaussian → fatness > 1 (bad)
  const leftTailExcess5  = sigma > 0 ? (gauss5th - emp5th) / sigma : 0;   // > 0 = fatter than Gaussian
  const leftTailExcess1  = sigma > 0 ? (gauss1st - emp1st) / sigma : 0;
  const rightTailExcess5 = sigma > 0 ? (emp95th - gauss95th) / sigma : 0; // > 0 = fatter right tail
  const rightTailExcess1 = sigma > 0 ? (emp99th - gauss99th) / sigma : 0;

  // Tail ratio: right 95th / |left 5th| — directional tail asymmetry
  const tailRatio = Math.abs(emp5th) > 1e-10 ? emp95th / Math.abs(emp5th) : 1.0;

  // ── Hill estimator for tail index α (Extreme Value Theory) ───────────────
  // Uses top k order statistics (left tail), k = 10% of sample
  const kHill = Math.max(5, Math.floor(n * 0.10));
  // Left tail: use absolute values of the most negative returns
  const leftReturns = sorted.slice(0, kHill).map(r => -r); // flip sign so all positive
  const xMin = leftReturns[leftReturns.length - 1];          // k-th largest (threshold)
  const hillSum = leftReturns.reduce((s, r) => s + Math.log(Math.max(r, xMin + 1e-12) / xMin), 0);
  const hillAlpha = hillSum > 0 ? kHill / hillSum : Infinity; // tail index

  // ── Composite signal ──────────────────────────────────────────────────────
  // Left tail fatter than Gaussian → bearish (crash risk underpriced by vol models)
  // Right tail fatter → bullish (breakout potential underpriced)
  // Tail ratio < 1 → left dominates → bearish
  // Tail ratio > 1 → right dominates → bullish
  const tailRatioScore  = atan10(Math.log(tailRatio), 0.3);       // log(1)=0, log(0.7)≈-0.36→neg, log(1.4)≈+0.34→pos
  const leftFatnessScore = atan10(-leftTailExcess5, 0.8);          // fatter left → negative
  const score = clamp(tailRatioScore * 0.6 + leftFatnessScore * 0.4, -10, 10);

  const tailReg = tailRatio > 1.15 ? 'RIGHT_TAIL_DOM (bullish tail)'
                : tailRatio < 0.85 ? 'LEFT_TAIL_DOM (crash risk)'
                : 'BALANCED_TAILS';
  const hillReg = hillAlpha < 3 ? 'POWER_LAW (very fat)'
                : hillAlpha < 5 ? 'FAT_TAILS'
                : 'MODERATE_TAILS';

  return {
    score,
    available:       true,
    emp5th:          +emp5th.toFixed(5),
    gauss5th:        +gauss5th.toFixed(5),
    leftTailExcess5: +leftTailExcess5.toFixed(3),
    tailRatio:       +tailRatio.toFixed(3),
    hillAlpha:       isFinite(hillAlpha) ? +hillAlpha.toFixed(2) : null,
    tailReg,
    hillReg,
    detail: `TailRatio=${tailRatio.toFixed(2)} LeftExcess=${leftTailExcess5.toFixed(2)}σ | ${tailReg}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. NON-NORMAL DISTRIBUTIONS — Regime & Mixture Model Signal
// ─────────────────────────────────────────────────────────────────────────────
// Equity returns are demonstrably non-Gaussian.  The key non-normal features:
//   1. Negative skewness    (left tail asymmetry)
//   2. Excess kurtosis      (fat tails relative to Gaussian)
//   3. Volatility clustering (GARCH — covered separately)
//   4. Regime mixing        (returns look like a mixture of normals)
//
// This signal models the return distribution as a mixture of two Gaussians
// (calm regime + stressed regime) using Expectation-Maximisation.
// The mixing weight of the STRESSED component is the primary signal:
//   high stressed weight → heightened tail risk → bearish
//   low stressed weight  → benign environment → slight bullish
//
// Also computes the ANDERSON-DARLING-style normality score comparing the
// empirical CDF to the fitted Gaussian — quantifying how non-normal the
// current period is.

function nonNormalDistSignal(closes, period = 80) {
  if (closes.length < period + 2) {
    return { score: 0, available: false, detail: 'Insufficient data for distribution fit' };
  }

  const priceSlice = closes.slice(-(period + 1));
  const returns    = [];
  for (let i = 1; i < priceSlice.length; i++) {
    returns.push(Math.log(priceSlice[i] / priceSlice[i - 1]));
  }

  const n   = returns.length;
  const mu  = _mean(returns);
  const sig = Math.sqrt(Math.max(_moment(returns, mu, 2), 1e-12));

  // ── Gaussian Mixture Model (2 components) via EM ─────────────────────────
  // Component 0: calm (low vol, near zero mean)
  // Component 1: stressed (high vol, potentially negative mean)
  let gmu   = [mu * 0.5,       mu - 0.5 * sig];
  let gsig  = [sig * 0.6,      sig * 1.8];
  let gpi   = [0.75,           0.25];

  const gaussPDF = (x, m, s) =>
    s < 1e-10 ? 0 : Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));

  for (let iter = 0; iter < 40; iter++) {
    // E-step: responsibilities
    const r0 = returns.map(x => {
      const p0 = gpi[0] * gaussPDF(x, gmu[0], gsig[0]);
      const p1 = gpi[1] * gaussPDF(x, gmu[1], gsig[1]);
      const tot = p0 + p1 + 1e-300;
      return [p0 / tot, p1 / tot];
    });

    // M-step
    for (let k = 0; k < 2; k++) {
      const rk  = r0.map(r => r[k]);
      const Nk  = rk.reduce((s, v) => s + v, 0);
      if (Nk < 1e-9) continue;
      gpi[k]  = Nk / n;
      gmu[k]  = rk.reduce((s, v, i) => s + v * returns[i], 0) / Nk;
      gsig[k] = Math.sqrt(Math.max(
        rk.reduce((s, v, i) => s + v * (returns[i] - gmu[k]) ** 2, 0) / Nk,
        1e-8
      ));
    }
  }

  // Identify stressed component: the one with LOWER mean and HIGHER sigma
  // (stressed means lower return, more volatile)
  const stressedComp = gmu[0] < gmu[1] ? 0 : 1;
  const stressedWeight = gpi[stressedComp];
  const stressedMu     = gmu[stressedComp];
  const stressedSig    = gsig[stressedComp];

  // ── Kolmogorov-Smirnov distance from Gaussian ─────────────────────────────
  // KS statistic = max |F_empirical(x) - F_gaussian(x)|
  // Large KS → highly non-normal → distribution modelling matters more
  const sorted = [...returns].sort((a, b) => a - b);
  const normCDF = (x) => 0.5 * (1 + erf((x - mu) / (sig * Math.SQRT2)));
  const erf = (x) => {  // Abramowitz & Stegun approximation
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
               - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  let ksMax = 0;
  for (let i = 0; i < n; i++) {
    const empCDF = (i + 1) / n;
    const gauCDF = normCDF(sorted[i]);
    ksMax = Math.max(ksMax, Math.abs(empCDF - gauCDF));
  }

  // ── Signal logic ──────────────────────────────────────────────────────────
  // Stressed weight 25% = Gaussian baseline for equities (moderate fat tails)
  // > 40% = elevated stress → bearish
  // < 15% = benign → slight bullish
  const stressScore = atan10(-(stressedWeight - 0.25), 0.15);   // 0.25 = neutral baseline

  // KS distance: high non-normality amplifies the stress signal slightly
  const ksAmplifier = 1 + clamp(ksMax / 0.15, 0, 0.5);          // 1.0 to 1.5×
  const score = clamp(stressScore * ksAmplifier, -10, 10);

  const stressReg = stressedWeight > 0.40 ? 'HIGH_STRESS_MIX'
                  : stressedWeight > 0.28 ? 'ELEVATED_STRESS'
                  : stressedWeight < 0.15 ? 'BENIGN_MIX'
                  : 'NORMAL_MIX';

  return {
    score,
    available:      true,
    stressedWeight: +stressedWeight.toFixed(3),
    stressedMu:     +stressedMu.toFixed(5),
    stressedSig:    +stressedSig.toFixed(5),
    ksDistance:     +ksMax.toFixed(4),
    stressReg,
    detail: `StressMix=${(stressedWeight*100).toFixed(0)}% KS=${ksMax.toFixed(3)} → ${stressReg}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. CENTRAL LIMIT THEOREM — Time-Scale Convergence Signal
// ─────────────────────────────────────────────────────────────────────────────
// The CLT states that the sum (or average) of n iid random variables converges
// to a Gaussian as n → ∞.  For trading this has key implications:
//
//   • INTRADAY (n small): returns are highly non-Gaussian, skewed, fat-tailed.
//     Individual 5m bars are volatile and non-predictable.
//   • DAILY (n = ~78 bars/day): partially averaged — still fat-tailed but less so.
//   • WEEKLY (n = ~390 bars/week): closer to Gaussian; CLT convergence meaningful.
//   • MONTHLY (n = ~1700 bars): well into CLT territory; distribution nearly normal.
//
// PRACTICAL SIGNAL:
// The CLT rate of convergence depends on SKEWNESS and KURTOSIS of the underlying
// distribution.  Berry-Esseen theorem: the error in CLT approximation is bounded by:
//   C × |third moment| / (σ³ × √n)
// So if the underlying distribution is very skewed/fat-tailed, CLT convergence is
// slower → intraday signals based on Gaussian assumptions are LESS reliable.
//
// This signal measures the Berry-Esseen bound for the current n (number of bars
// in the chosen aggregation window) and outputs:
//   • HIGH bound → Gaussian assumptions badly wrong → ↓ weight of z-score/OU signals
//   • LOW bound  → CLT has kicked in → Gaussian tools reasonably valid → ↑ confidence
//
// For DIRECTION: the CLT signal is primarily a CONFIDENCE MODIFIER, not directional.
// However, when CLT convergence is poor (intraday, fat tails), the DISTRIBUTION
// of returns has predictable structure → use empirical return quantiles for direction.
// If the last return is in the extreme left tail (< 2% empirical) → mean reversion likely.

function cltConvergenceSignal(closes, period = 60) {
  if (closes.length < period + 2) {
    return { score: 0, available: false, detail: 'Insufficient data for CLT analysis' };
  }

  const priceSlice = closes.slice(-(period + 1));
  const returns    = [];
  for (let i = 1; i < priceSlice.length; i++) {
    returns.push(Math.log(priceSlice[i] / priceSlice[i - 1]));
  }

  const n      = returns.length;
  const mu     = _mean(returns);
  const sigma  = Math.sqrt(Math.max(_moment(returns, mu, 2), 1e-12));
  const m3abs  = Math.abs(_moment(returns, mu, 3));

  // Berry-Esseen bound: C × |μ₃| / (σ³ × √n) where C ≈ 0.4748
  const berryCLT = sigma > 0 ? 0.4748 * m3abs / (sigma ** 3 * Math.sqrt(n)) : 0;
  // Interpretation: the CDF error is bounded by berryCLT
  // < 0.05 → Gaussian is a good approximation (< 5% CDF error)
  // > 0.20 → Gaussian is a poor approximation (> 20% CDF error)

  // ── Empirical return percentile for the MOST RECENT return ───────────────
  const lastReturn = returns[returns.length - 1];
  const sorted     = [...returns].sort((a, b) => a - b);
  let empPct = sorted.filter(r => r <= lastReturn).length / n;
  empPct = clamp(empPct, 0.01, 0.99);

  // If last return is in the extreme tails AND CLT convergence is poor:
  // mean-reversion signal (returns are bounded by empirical distribution)
  // empPct < 0.05 → last bar was extreme bearish → MR → bullish
  // empPct > 0.95 → last bar was extreme bullish → MR → bearish
  let mrSignal = 0;
  if (berryCLT > 0.10) {  // non-Gaussian regime: use empirical distribution
    if (empPct < 0.05)       mrSignal = +(1 - empPct / 0.05) * 5;   // 0 to +5
    else if (empPct > 0.95)  mrSignal = -(empPct - 0.95) / 0.05 * 5; // 0 to -5
  }

  // ── Gaussian validity → confidence modifier (not strongly directional) ────
  // When CLT has converged (low Berry-Esseen bound): other signals using Gaussian
  // tools (z-score MR, OU, VWAP z-score) are MORE reliable.
  // gaussianValidityMultiplier: 1.0 when CLT holds well, 0.7 when it breaks down
  const gaussianValidityMultiplier = clamp(1.0 - berryCLT * 3, 0.5, 1.0);

  const score = clamp(mrSignal, -10, 10);

  const cltReg = berryCLT < 0.05 ? 'CLT_CONVERGED (Gaussian valid)'
               : berryCLT < 0.15 ? 'PARTIAL_CLT (use caution)'
               : 'CLT_POOR (empirical dist matters)';

  const tailPct = empPct < 0.05 ? 'EXTREME_LEFT_TAIL'
                : empPct > 0.95 ? 'EXTREME_RIGHT_TAIL'
                : empPct < 0.20 ? 'LEFT_TAIL'
                : empPct > 0.80 ? 'RIGHT_TAIL'
                : 'BODY';

  return {
    score,
    available:                 true,
    berryCLT:                  +berryCLT.toFixed(4),
    empPct:                    +empPct.toFixed(3),
    lastReturn:                +lastReturn.toFixed(5),
    gaussianValidityMultiplier: +gaussianValidityMultiplier.toFixed(3),
    cltReg,
    tailPct,
    detail: `BE=${berryCLT.toFixed(3)} last_ret=${(lastReturn*100).toFixed(2)}% [${tailPct}] → ${cltReg.split(' ')[0]}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. VARIANCE RATIO TEST  (Lo & MacKinlay 1988)
// ─────────────────────────────────────────────────────────────────────────────
// Tests whether log-price follows a random walk by comparing the variance of
// q-period returns to q × variance of 1-period returns.
//
//   VR(q) = Var(r_t + r_{t-1} + … + r_{t-q+1}) / (q × Var(r_t))
//
//   VR > 1 → positive serial correlation → MOMENTUM environment
//   VR < 1 → negative serial correlation → MEAN_REVERSION environment
//   VR ≈ 1 → random walk
//
// Uses the heteroscedasticity-robust z-statistic (Lo-MacKinlay eq. 14).
// Complements Hurst (long-range dependence, H > 0.5) by catching the
// short-horizon (4-day) autocorrelation structure Hurst misses.
// Complements MRSM by providing a non-parametric regime-switching signal.

function varianceRatioSignal(closes, q = 4) {
  const n = closes.length;
  if (n < q * 6) return { score: 0, available: false, detail: `Need ${q * 6}+ bars` };

  const T = n - 1;
  const logRet = [];
  for (let i = 1; i <= T; i++) logRet.push(Math.log(closes[i] / closes[i - 1]));

  const mu = logRet.reduce((s, r) => s + r, 0) / T;

  // 1-period variance (unbiased)
  const var1 = logRet.reduce((s, r) => s + (r - mu) ** 2, 0) / (T - 1);
  if (var1 < 1e-12) return { score: 0, available: false, detail: 'Zero variance' };

  // q-period variance using overlapping windows (bias-corrected denominator)
  const m = q * (T - q + 1) * (1 - q / T);
  let sumQ = 0;
  for (let t = q - 1; t < T; t++) {
    let rq = 0;
    for (let j = 0; j < q; j++) rq += logRet[t - j];
    sumQ += (rq - q * mu) ** 2;
  }
  const varQ = sumQ / m;

  const vr = varQ / var1;

  // Heteroscedasticity-robust standard error (Lo-MacKinlay 1988, eq. 14)
  let vrSE2 = 0;
  const ss2 = logRet.reduce((s, r) => s + (r - mu) ** 2, 0);
  for (let j = 1; j < q; j++) {
    const theta_j_weight = (2 * (q - j) / q) ** 2;
    let delta_j = 0;
    for (let t = j; t < T; t++) {
      delta_j += (logRet[t] - mu) ** 2 * (logRet[t - j] - mu) ** 2;
    }
    delta_j = (T * delta_j) / (ss2 * ss2);
    vrSE2 += theta_j_weight * delta_j;
  }
  // Lo-MacKinlay (1988) eq. 14: z*(q) = sqrt(T) × (VR-1) / sqrt(θ*(q))
  // Missing sqrt(T) would make z-stat ~7–8× too small for typical 60-bar windows.
  const zStat = vrSE2 > 1e-12 ? Math.sqrt(T) * (vr - 1) / Math.sqrt(vrSE2) : 0;

  // Score: strong positive z → momentum bullish; strong negative z → MR bearish
  // (MR means fading extreme moves, which tends to be neutral-to-bullish in calm markets)
  // We score momentum as positive, MR as negative (momentum is the directional signal here).
  // The regime adjuster in bias.js will up-weight momentum signals when VR > 1.
  const score = atan10(zStat, 2.0);  // |z| = 2 → score ±7.2

  const regime = vr > 1.08 ? 'MOMENTUM'
               : vr < 0.92 ? 'MEAN_REVERSION'
               : 'RANDOM_WALK';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    vr:        +vr.toFixed(4),
    zStat:     +zStat.toFixed(3),
    q,
    regime,
    detail:    `VR(${q})=${vr.toFixed(3)} z=${zStat.toFixed(2)} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. VOL SURFACE BUTTERFLY  (IV curvature / kurtosis risk premium)
// ─────────────────────────────────────────────────────────────────────────────
// The butterfly measures the curvature of the IV smile: how much MORE expensive
// OTM wings are versus the ATM strike.  It is a market-priced kurtosis (fat-tail)
// premium and is DISTINCT from the slope (skew / rr25d) and the gradient (IV
// skew slope).
//
//   butterfly = avgWingIV / ATM_IV  − 1   (normalized curvature)
//
//   High butterfly (>0.15): wings expensive → fat tails priced → more uncertainty
//   Low butterfly (<0.03):  flat smile → complacency / gamma-pinned market
//   Extreme butterfly (>0.40): capitulation fear — contrarian bullish
//
// Sources: Carr & Madan (2001) variance swap decomposition; Bergomi (2016) "Stochastic
// Volatility Modeling" Ch. 2; "impliedvolatility.donotshare" (smile curvature section).

function volSurfaceButterflySignal(chain, spot) {
  if (!chain || !spot || spot <= 0) return { score: 0, available: false, detail: 'No chain' };
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  // Prefer nearest liquid expiry (2–45 DTE)
  const exps = [...new Set([...calls, ...puts].map(c => c.expiration))]
    .filter(ts => (ts - now) / 86400 >= 2 && (ts - now) / 86400 <= 60)
    .sort((a, b) => a - b);

  for (const expTs of exps.slice(0, 3)) {
    const atmBucket = [], wingBucket = [];

    const collect = (contract) => {
      if (contract.expiration !== expTs || contract.strike <= 0) return;
      const iv = contract.impliedVolatility;
      if (!iv || iv < 0.01 || iv > 3) return;
      const m = Math.abs(contract.strike - spot) / spot;
      if (m < 0.025)              atmBucket.push(iv);   // within 2.5% moneyness
      else if (m >= 0.04 && m <= 0.10) wingBucket.push(iv);  // 4–10% OTM wings
    };

    calls.forEach(collect);
    puts.forEach(collect);

    if (atmBucket.length < 1 || wingBucket.length < 2) continue;

    const atmIV  = atmBucket.reduce((s, v) => s + v, 0) / atmBucket.length;
    const wingIV = wingBucket.reduce((s, v) => s + v, 0) / wingBucket.length;
    if (atmIV < 0.01) continue;

    const butterfly = wingIV / atmIV - 1;   // normalized curvature ≥ 0

    // Extreme curvature = panic buying of wings = capitulation → contrarian bullish
    // Normal curvature = healthy fear → slight bearish tilt
    // Flat = complacency → slightly bearish medium-term
    let score;
    if (butterfly > 0.45) {
      score = +4;  // capitulation — contrarian bullish
    } else if (butterfly < 0.02) {
      score = -3;  // flat smile — complacency / risk-on excess
    } else {
      // Increasing curvature → more tail risk priced → bearish for MR strategies
      score = clamp(atan10(-butterfly, 0.10), -10, 10);
    }

    const regime = butterfly > 0.45 ? 'CAPITULATION'
                 : butterfly > 0.20 ? 'FAT_TAIL_PREMIUM'
                 : butterfly > 0.06 ? 'NORMAL_SMILE'
                 : 'FLAT';

    const dte = Math.round((expTs - now) / 86400);
    return {
      score,
      available:  true,
      butterfly:  +butterfly.toFixed(4),
      atmIV:      +atmIV.toFixed(4),
      wingIV:     +wingIV.toFixed(4),
      dteUsed:    dte,
      regime,
      detail: `bfly=${(butterfly*100).toFixed(1)}% ATM=${(atmIV*100).toFixed(1)}% wing=${(wingIV*100).toFixed(1)}% [${regime}]`,
    };
  }

  return { score: 0, available: false, detail: 'No liquid expiry for butterfly' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. CUMULATIVE VOLUME DELTA DIVERGENCE  (CVD)
// ─────────────────────────────────────────────────────────────────────────────
// CVD accumulates the "directional" volume from 5-minute bars: each bar's
// volume is signed positive if close > open (buying pressure) and negative if
// close < open (selling pressure).
//
// Divergence detection — the primary signal:
//   Price higher but CVD falling  → sellers driving the rally  → BEARISH divergence
//   Price lower  but CVD rising   → buyers absorbing the drop  → BULLISH divergence
//
// Confirmation is a secondary, lower-amplitude signal.
//
// Sources: Wyckoff (1910); Dalton "Mind Over Markets" (1990) for TPO/volume analysis;
// practitioner order-flow literature.

function cvdDivergenceSignal(bars5m, lookback = 20) {
  if (!bars5m || bars5m.length < Math.max(lookback, 6)) {
    return { score: 0, available: false, detail: 'No 5m data' };
  }

  const recent = bars5m.slice(-lookback);

  // Build CVD series
  let cvd = 0;
  const cvdSeries = recent.map(b => {
    const dir = Math.sign(b.close - b.open);
    cvd += dir * (b.volume ?? 0);
    return cvd;
  });

  // Split into two halves: first half as baseline, second half as recent
  const mid = Math.floor(recent.length / 2);
  const cvdBaseline  = cvdSeries[mid - 1];
  const cvdCurrent   = cvdSeries[cvdSeries.length - 1];
  const priceBaseline = recent[mid - 1].close;
  const priceCurrent  = recent[recent.length - 1].close;

  const priceDir  = Math.sign(priceCurrent - priceBaseline);
  const cvdDir    = Math.sign(cvdCurrent - cvdBaseline);
  const isDivergence = priceDir !== 0 && cvdDir !== 0 && priceDir !== cvdDir;

  // Normalized CVD change: fraction of total period volume
  const totalVol = recent.reduce((s, b) => s + (b.volume ?? 0), 0) || 1;
  const cvdMag   = Math.abs(cvdCurrent - cvdBaseline) / totalVol;  // 0–1

  // Price momentum magnitude (% move)
  const priceMag = Math.abs(priceCurrent / priceBaseline - 1);

  let score = 0;
  let regime = 'NEUTRAL';

  if (isDivergence) {
    // CVD contradicts price — leading indicator of reversal
    // Score in the CVD direction (buying into weakness = bullish, etc.)
    const base = 3 + cvdMag * 7;  // magnitude scales with strength of divergence
    score = cvdDir * base;
    regime = cvdDir > 0 ? 'BULLISH_DIVERGENCE' : 'BEARISH_DIVERGENCE';
  } else if (priceDir !== 0 && cvdDir !== 0) {
    // Confirmation: both price and CVD agree → trend continuation
    const base = cvdMag * 4;
    score = priceDir * base;
    regime = priceDir > 0 ? 'BULLISH_CONFIRM' : 'BEARISH_CONFIRM';
  }

  return {
    score:     clamp(score, -10, 10),
    available: true,
    cvdMag:    +cvdMag.toFixed(4),
    priceDir,
    cvdDir,
    isDivergence,
    regime,
    detail:    `CVD ${cvdDir > 0 ? '↑' : '↓'} price ${priceDir > 0 ? '↑' : '↓'} mag=${(cvdMag*100).toFixed(1)}% [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. AMIHUD ILLIQUIDITY Z-SCORE  (Amihud 2002)
// ─────────────────────────────────────────────────────────────────────────────
// Amihud (2002) illiquidity ratio: ILLIQ = |return| / volume per bar.
// High ILLIQ = large price move per unit of volume = thin book = illiquid.
//
// We z-score the current bar's ILLIQ against recent history, so the signal is
// scale-invariant across instruments (ES futures vs SPY ETF vs single stocks).
//
//   z > +2  → current bar anomalously illiquid → vol expansion / instability
//   z < -1  → unusually liquid (deep book) → stable / mean-reverting
//
// Illiquidity is negatively correlated with expected returns in the cross-section
// (Amihud 2002) — BUT in the time series context (single instrument), elevated
// illiquidity signals that each trade has outsize impact → vol expansion → bearish.
//
// Source: Amihud, Y. (2002). "Illiquidity and stock returns." JFM 5(1), 31–56.

function amihudIlliquiditySignal(bars, lookback = 25) {
  if (!bars || bars.length < lookback + 2) {
    return { score: 0, available: false, detail: `Need ${lookback + 2}+ bars` };
  }

  const recent = bars.slice(-lookback);

  // ILLIQ_t = |log(close/open)| / volume
  const illiq = recent.map(b => {
    const ret = Math.abs(Math.log(b.close / (b.open || b.close)));
    const vol = b.volume || 1;
    return ret / vol;
  });

  // Z-score: current vs rolling historical (exclude current bar from reference)
  const hist    = illiq.slice(0, -1);
  const current = illiq[illiq.length - 1];
  const mean    = hist.reduce((s, v) => s + v, 0) / hist.length;
  const std     = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length);
  if (std < 1e-20) return { score: 0, available: false, detail: 'Zero illiquidity variance' };

  const z = (current - mean) / std;

  // High z = anomalous illiquidity = price moves too fast per unit of volume
  //   → market is thin, vol expanding, harder to execute → bearish composite
  // Low z  = very liquid = book is deep, price stable → slightly bullish
  const score = -(2 / Math.PI) * Math.atan(z / 1.5) * 10;

  const regime = z >  2   ? 'ILLIQUID'
               : z < -1   ? 'DEEP_BOOK'
               : 'NORMAL';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    amihudZ:   +z.toFixed(3),
    current:   +current.toFixed(10),
    regime,
    detail:    `Amihud z=${z.toFixed(2)} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. DELTA-WEIGHTED PUT/CALL RATIO  (DPCR)
// ─────────────────────────────────────────────────────────────────────────────
// Standard put/call ratio weights each contract equally (or by OI/vol count).
// DPCR weights each contract by |delta| × OI — capturing the ACTUAL directional
// exposure of open positions.  Deep ITM options (delta ≈ 1) count more than
// cheap OTM lotto tickets (delta ≈ 0.05) that dominate raw P/C in panic.
//
//   DPCR = Σ(|put_Δ| × put_OI) / Σ(|call_Δ| × call_OI)
//
//   DPCR > 1.3 → significant downside hedging → contrarian BULLISH
//   DPCR < 0.7 → upside speculation dominates → contrarian BEARISH
//   DPCR ≈ 1.0 → balanced
//
// This complements (not replaces) the raw putCallRatio: raw P/C captures panic
// OTM buying; DPCR captures STRUCTURAL repositioning of delta-sensitive hedges.
//
// Source: Bollen & Whaley (2004). "Does net buying pressure affect the shape of
// implied volatility functions?" Journal of Finance.

// (greeks and RISK_FREE_DPCR are now declared at the top of this module)

function deltaWeightedPCRSignal(chain, spot) {
  if (!chain || !spot || spot <= 0) return { score: 0, available: false, detail: 'No chain' };
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  let putDW = 0, callDW = 0;
  let putCount = 0, callCount = 0;

  const processContract = (contract, type) => {
    const dte = (contract.expiration - now) / 86400;
    if (dte < 0.5 || dte > 90 || contract.strike <= 0) return;
    const T     = dte / 365;
    const iv    = contract.impliedVolatility > 0.01 ? contract.impliedVolatility : 0.25;
    const oi    = (contract.openInterest ?? 0) > 0 ? contract.openInterest : (contract.volume ?? 0);
    if (oi < 1) return;
    const g     = _bsGreeks(spot, contract.strike, RISK_FREE_DPCR, iv, T, type);
    const absDelta = Math.abs(g.delta);
    if (absDelta < 0.01) return;  // skip very deep OTM (noise)
    const weight = absDelta * oi;
    if (type === 'call') { callDW += weight; callCount++; }
    else                 { putDW  += weight; putCount++;  }
  };

  calls.forEach(c => processContract(c, 'call'));
  puts.forEach(p  => processContract(p, 'put'));

  if (callDW < 1 || putDW < 1) return { score: 0, available: false, detail: 'Insufficient delta-weighted OI' };

  const dpcr = putDW / callDW;

  // Contrarian scoring: high DPCR (heavy put delta) = fear = bullish opportunity
  // Mirrors raw P/C logic but with BSM-delta weighting for structural accuracy
  let score;
  if      (dpcr > 2.5) score = +9;
  else if (dpcr > 1.6) score = +6;
  else if (dpcr > 1.3) score = +3;
  else if (dpcr > 0.8) score = 0;
  else if (dpcr > 0.6) score = -3;
  else if (dpcr > 0.4) score = -6;
  else                 score = -9;

  const regime = dpcr > 1.6 ? 'HEAVY_HEDGE'
               : dpcr > 1.1 ? 'ELEVATED_PUTS'
               : dpcr < 0.7 ? 'CALL_SPECULATION'
               : 'BALANCED';

  return {
    score,
    available:  true,
    dpcr:       +dpcr.toFixed(3),
    putDeltaOI: +putDW.toFixed(0),
    callDeltaOI:+callDW.toFixed(0),
    regime,
    detail: `DPCR=${dpcr.toFixed(2)} (put Δ·OI=${(putDW/1e3).toFixed(0)}K call=${(callDW/1e3).toFixed(0)}K) [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. IV SKEW SLOPE
// ─────────────────────────────────────────────────────────────────────────────
// Measures the slope of the implied volatility smile/smirk across strikes via
// OLS regression.  Sources: "Implied Volatility Surface" (Fengler 2005) and
// "impliedvolatility.donotshare".
//
// Equity indexes naturally carry a negative skew (put smirk):
//   slope < -2.5  → CAPITULATION_SKEW  — extreme fear, contrarian bullish
//   slope < -1.0  → STEEP_PUT_SKEW     — elevated fear / bearish context
//   slope -1.0 to -0.3 → NORMAL_PUT_SKEW  — standard equity skew
//   slope > +0.5  → CALL_SKEW          — complacency / risk-on
//
// Complement to rr25d (which uses two specific Δ strikes); skew slope
// measures the full gradient across ±15% moneyness, detecting smirk vs smile.

function ivSkewSlopeSignal(chain, spot) {
  if (!chain || !spot || spot <= 0) return { score: 0, available: false, detail: 'No chain' };
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  // Use OTM-only conventions to avoid stale ITM bid/ask quotes biasing the regression.
  // OTM calls: strike > spot (positive moneyness).
  // OTM puts:  strike < spot (negative moneyness — put moneyness = -(K-S)/S).
  // Near ATM (|m| < 0.01) included for both sides as the smile apex anchor.
  const points = [];
  const addIV = (m, iv) => {
    if (iv > 0.01 && iv < 3.0) points.push({ m, iv });
  };

  calls.forEach(c => {
    const dte = (c.expiration - now) / 86400;
    if (dte < 1 || dte > 60 || c.strike <= 0) return;
    const m = (c.strike - spot) / spot;
    // OTM calls: m >= 0 (ATM included); skip deep ITM calls (m < -0.01)
    if (m >= -0.01 && m <= 0.15) addIV(m, c.impliedVolatility);
  });
  puts.forEach(p => {
    const dte = (p.expiration - now) / 86400;
    if (dte < 1 || dte > 60 || p.strike <= 0) return;
    const m = (p.strike - spot) / spot;   // negative for OTM puts (K < S)
    // OTM puts: m <= 0 (ATM included); skip deep ITM puts (m > 0.01)
    if (m >= -0.15 && m <= 0.01) addIV(m, p.impliedVolatility);
  });

  if (points.length < 5) return { score: 0, available: false, detail: `Only ${points.length} IV points` };

  // OLS: IV = intercept + slope × moneyness
  const n     = points.length;
  const meanM = points.reduce((s, p) => s + p.m,  0) / n;
  const meanI = points.reduce((s, p) => s + p.iv, 0) / n;
  const ssXY  = points.reduce((s, p) => s + (p.m - meanM) * (p.iv - meanI), 0);
  const ssX   = points.reduce((s, p) => s + (p.m - meanM) ** 2, 0);
  if (ssX < 1e-10) return { score: 0, available: false, detail: 'No moneyness spread' };

  const slope     = ssXY / ssX;
  const intercept = meanI - slope * meanM; // ATM IV estimate at moneyness = 0

  // Extreme negative slope = capitulation put buying → contrarian bullish
  let score;
  if (slope < -2.5) {
    score = +4; // capitulation fear — contrarian bullish (put walls priced in)
  } else {
    // Normal range: steep put skew bearish, call skew bullish
    score = atan10(-slope, 0.8);
  }

  const regime = slope < -2.5 ? 'CAPITULATION_SKEW'
               : slope < -1.0 ? 'STEEP_PUT_SKEW'
               : slope < -0.3 ? 'NORMAL_PUT_SKEW'
               : slope >  0.5 ? 'CALL_SKEW'
               : 'FLAT_SMILE';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    slope:     +slope.toFixed(3),
    atmIV:     +intercept.toFixed(3),
    nPoints:   n,
    regime,
    detail:    `slope=${slope.toFixed(2)} ATM IV=${(intercept * 100).toFixed(1)}% n=${n} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. ATM STRADDLE EXPECTED MOVE vs REALIZED MOVE
// ─────────────────────────────────────────────────────────────────────────────
// Sources: "GAMMA_Methodology" (Bouchaud et al.); "Putting_volatility_to_work"
//
// ATM straddle price ≈ market's priced expected daily range.
// Realized move = today's |close - open| / open.
//
// ratio = realizedMove / expectedMove
//   ratio > 2.0  → EXTREME_BREAKOUT  — far beyond straddle; exhaustion / MR likely
//   ratio > 1.2  → ABOVE_EXPECTED    — broke out; mild MR bias
//   ratio 0.35-1.2 → NORMAL
//   ratio < 0.35  → PINNED           — gamma suppressing moves; pin continuation
//   ratio < 0.15  → ULTRA_PINNED     — 0DTE-style pin; strong MR / hold bias

function straddleExpectedMoveSignal(chain, spot, bars) {
  if (!chain || !spot || spot <= 0 || !bars?.length) {
    return { score: 0, available: false, detail: 'No data' };
  }
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  const expirations = [...new Set([...calls, ...puts].map(c => c.expiration))]
    .filter(ts => ts > now)
    .sort((a, b) => a - b);

  if (!expirations.length) return { score: 0, available: false, detail: 'No expirations' };

  // Try nearest 3 expiries to find one with a valid ATM bid/ask pair
  for (const expTs of expirations.slice(0, 3)) {
    const nearCalls = calls.filter(c => c.expiration === expTs && c.strike > 0);
    const nearPuts  = puts.filter( p => p.expiration === expTs && p.strike > 0);
    if (!nearCalls.length || !nearPuts.length) continue;

    const atmStrike = nearCalls.map(c => c.strike).reduce(
      (best, k) => Math.abs(k - spot) < Math.abs(best - spot) ? k : best,
      nearCalls[0].strike
    );

    const atmCall = nearCalls.find(c => c.strike === atmStrike);
    const atmPut  = nearPuts.find( p => p.strike === atmStrike);
    if (!atmCall || !atmPut) continue;

    const cMid = atmCall.bid > 0 || atmCall.ask > 0
      ? (atmCall.bid + atmCall.ask) / 2 : (atmCall.lastPrice ?? 0);
    const pMid = atmPut.bid  > 0 || atmPut.ask  > 0
      ? (atmPut.bid  + atmPut.ask)  / 2 : (atmPut.lastPrice  ?? 0);
    if (cMid <= 0 || pMid <= 0) continue;

    const straddlePrice   = cMid + pMid;
    const dte             = (expTs - now) / 86400;
    // Horizon normalization: straddle price prices the full DTE expected move.
    // Realized move is an intraday (1-day, partial) move.
    // Divide straddle by sqrt(DTE) to convert to a 1-day expected move before
    // comparing — without this, a 5-DTE straddle at 2% systematically looks
    // "large" vs a 0.5% intraday move, biasing the signal toward PINNED/ULTRA_PINNED.
    const dteFactor       = Math.max(Math.sqrt(Math.max(dte, 1)), 1);
    const expectedMovePct = (straddlePrice / spot) / dteFactor;  // per-day expected move
    if (expectedMovePct < 0.0003) continue;              // stale/unrealistic price

    // Realized move: today's bar |close − open| / open (partial day, best approximation)
    const bar = bars[bars.length - 1];
    if (!bar) continue;
    const realizedMovePct = Math.abs(bar.close - bar.open) / bar.open;

    const ratio = realizedMovePct / expectedMovePct;

    let score = 0, label = 'NORMAL';
    if      (ratio > 2.0)  { score = -8; label = 'EXTREME_BREAKOUT'; }
    else if (ratio > 1.2)  { score = -4; label = 'ABOVE_EXPECTED';   }
    else if (ratio < 0.15) { score = +6; label = 'ULTRA_PINNED';     }
    else if (ratio < 0.35) { score = +3; label = 'PINNED';           }

    return {
      score,
      available:       true,
      straddlePrice:   +straddlePrice.toFixed(3),
      expectedMovePct: +expectedMovePct.toFixed(4),
      realizedMovePct: +realizedMovePct.toFixed(4),
      ratio:           +ratio.toFixed(3),
      dteUsed:         +dte.toFixed(1),
      label,
      detail: `straddle=${straddlePrice.toFixed(2)} exp1d=${(expectedMovePct*100).toFixed(2)}% real=${(realizedMovePct*100).toFixed(2)}% ratio=${ratio.toFixed(2)} dte=${dte.toFixed(1)} [${label}]`,
    };
  }

  return { score: 0, available: false, detail: 'No valid ATM pair' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. DOWNSIDE REALIZED SEMIVARIANCE  (Barndorff-Nielsen, Kinnebrock, Shephard 2010)
// ─────────────────────────────────────────────────────────────────────────────
// Split realized volatility into upside (positive-return) and downside
// (negative-return) components. "Bad vol" (downside) predicts future vol and
// negative returns better than symmetric RV (Patton & Sheppard 2015).
//
// Uses 5-minute bars to compute intraday semivariances.
// ratio = downSV / upSV:
//   > 1.5  → downside dominating → bearish (vol expansion, tail risk building)
//   < 0.67 → upside dominating  → bullish (positive momentum, low crash risk)

function downsideSemivarianceSignal(bars5m, lookback = 40) {
  if (!bars5m || bars5m.length < lookback + 2) {
    return { score: 0, available: false, detail: 'Need 5m bars for semivariance' };
  }
  const recent = bars5m.slice(-lookback);
  const rets = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > 0 && recent[i - 1].close > 0) {
      rets.push(Math.log(recent[i].close / recent[i - 1].close));
    }
  }
  if (rets.length < 10) return { score: 0, available: false, detail: 'Insufficient 5m returns' };

  const downRets = rets.filter(r => r < 0);
  const upRets   = rets.filter(r => r > 0);
  if (downRets.length < 3 || upRets.length < 3) {
    return { score: 0, available: false, detail: 'Insufficient directional returns' };
  }

  // Realized semivariances (per-bar averages, then annualize)
  const annFactor = 252 * 78; // 78 5-min bars per RTH session
  const downSV = downRets.reduce((s, r) => s + r * r, 0) / downRets.length;
  const upSV   = upRets.reduce((s, r) => s + r * r, 0) / upRets.length;
  const downVol = Math.sqrt(downSV * annFactor) * 100;
  const upVol   = Math.sqrt(upSV   * annFactor) * 100;

  // Ratio of downside to upside realized variance
  const ratio = upSV > 1e-14 ? downSV / upSV : 1.0;

  // High ratio → downside tail risk dominating → bearish for MR, bullish for hedges
  // Low ratio  → upside vol dominating → clean trending tape, bullish
  const score = atan10(-(ratio - 1.0), 0.6); // 0 at balanced, negative when ratio > 1

  const regime = ratio > 2.0 ? 'SEVERE_DOWNSIDE_DOM'
               : ratio > 1.5 ? 'DOWNSIDE_DOM'
               : ratio > 1.2 ? 'DOWNSIDE_ELEVATED'
               : ratio < 0.5 ? 'UPSIDE_DOM'
               : ratio < 0.75 ? 'UPSIDE_ELEVATED'
               : 'BALANCED';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    ratio:     +ratio.toFixed(3),
    downVol:   +downVol.toFixed(1),
    upVol:     +upVol.toFixed(1),
    regime,
    detail: `dSV/uSV=${ratio.toFixed(2)} dVol=${downVol.toFixed(0)}% uVol=${upVol.toFixed(0)}% [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. VPIN  (Easley, López de Prado & O'Hara 2012)
// ─────────────────────────────────────────────────────────────────────────────
// Volume-Synchronized Probability of Informed Trading.
// Divide total volume into equal-size buckets; classify each bucket as buy/sell
// via Lee-Ready proxy (close > open → buy, else → sell).
// VPIN = E[|buyVol − sellVol| / totalVol] per bucket.
//
// High VPIN → informed traders are active → vol expansion risk → bearish for MR.
// VPIN > 0.55 → elevated toxicity; > 0.70 → flash-crash risk territory.

function vpinSignal(bars5m, nBuckets = 50) {
  if (!bars5m || bars5m.length < nBuckets + 5) {
    return { score: 0, available: false, detail: 'Need 5m bars for VPIN' };
  }
  const recent = bars5m.slice(-Math.min(bars5m.length, nBuckets * 3));

  // Total volume across window
  const totalVol = recent.reduce((s, b) => s + (b.volume || 0), 0);
  if (totalVol < 1) return { score: 0, available: false, detail: 'Zero volume for VPIN' };

  // Divide into nBuckets equal-volume buckets
  const bucketTarget = totalVol / nBuckets;
  const bucketImbalances = [];
  let bBuy = 0, bSell = 0, bVol = 0;

  for (const bar of recent) {
    const vol = bar.volume || 0;
    if (!vol) continue;
    // Lee-Ready proxy: classify bar volume as buy or sell
    const dir = bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0;
    const buyVol  = (vol + dir * vol) / 2;  // all buy if dir=1, all sell if dir=-1, 50/50 if 0
    const sellVol = vol - buyVol;
    bBuy  += buyVol;
    bSell += sellVol;
    bVol  += vol;

    if (bVol >= bucketTarget) {
      const total = bBuy + bSell;
      bucketImbalances.push(total > 0 ? Math.abs(bBuy - bSell) / total : 0);
      bBuy = bSell = bVol = 0;
    }
  }
  if (bucketImbalances.length < 5) {
    return { score: 0, available: false, detail: `Only ${bucketImbalances.length} VPIN buckets` };
  }

  const vpin = bucketImbalances.reduce((s, v) => s + v, 0) / bucketImbalances.length;

  // Score: VPIN theoretical range is [0, 1].
  //   VPIN = 0 → perfectly balanced buy/sell in every bucket (pure noise / no informed trading)
  //   VPIN = 1 → all-buy or all-sell in every bucket (maximum toxicity)
  //   Real equity index range: ~0.20 (calm) to ~0.70 (stressed)
  // Neutral baseline ≈ 0.25; above = elevated toxicity → bearish for MR strategies.
  const score = -(2 / Math.PI) * Math.atan((vpin - 0.25) / 0.12) * 10;

  const regime = vpin > 0.65 ? 'HIGH_TOXICITY'
               : vpin > 0.45 ? 'ELEVATED'
               : vpin > 0.25 ? 'NORMAL'
               : 'LOW_TOXICITY';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    vpin:      +vpin.toFixed(4),
    nBuckets:  bucketImbalances.length,
    regime,
    detail: `VPIN=${(vpin * 100).toFixed(1)}% n=${bucketImbalances.length} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. SIGNED OPTION NET-BUYING PRESSURE
// ─────────────────────────────────────────────────────────────────────────────
// Bollen & Whaley (2004) "Does Net Buying Pressure Affect the Shape of Implied
// Volatility Functions?" Journal of Finance.
// Garleanu, Pedersen & Poteshman (2009) demand-based option pricing.
//
// Uses Lee-Ready proxy on option lastPrice vs bid-ask midpoint to classify
// whether the last trade was buyer- or seller-initiated.
// Net customer buying pressure → demand-driven IV changes → directional signal.
//
// signedFlow = (lastPrice − bid) / (ask − bid) → [0=sell, 1=buy]
// Net: aggregated across calls (positive = bullish) and puts (negative = bearish).

function signedOptionFlowSignal(chain, spot) {
  if (!chain || !spot || spot <= 0) {
    return { score: 0, available: false, detail: 'No chain for option flow' };
  }
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  let netCallFlow = 0, totalCallVol = 0;
  let netPutFlow  = 0, totalPutVol  = 0;

  const processContract = (contract, type) => {
    const dte = (contract.expiration - now) / 86400;
    if (dte < 0 || dte > 60) return;
    const vol  = contract.volume ?? 0;
    if (vol < 1) return;
    const bid  = contract.bid  ?? 0;
    const ask  = contract.ask  ?? 0;
    const last = contract.lastPrice ?? 0;
    if (bid <= 0 || ask <= 0 || last <= 0) return;
    const spread = ask - bid;
    if (spread <= 0) return;

    // Lee-Ready proxy: where in the bid-ask spread did the last trade execute?
    // 1.0 = at ask (aggressive buyer lifting offer)
    // 0.0 = at bid (aggressive seller hitting bid)
    const pressure = Math.max(0, Math.min(1, (last - bid) / spread));
    // Centre at 0.5: positive = net buy pressure, negative = net sell pressure
    const signed = (pressure - 0.5) * vol;

    if (type === 'call') { netCallFlow += signed; totalCallVol += vol; }
    else                  { netPutFlow  += signed; totalPutVol  += vol; }
  };

  calls.forEach(c => processContract(c, 'call'));
  puts.forEach(p  => processContract(p, 'put'));

  if (totalCallVol + totalPutVol < 10) {
    return { score: 0, available: false, detail: 'Insufficient option volume for flow signal' };
  }

  // Normalize each side to [-0.5, +0.5]
  const normCallFlow = totalCallVol > 0 ? netCallFlow / totalCallVol : 0;
  const normPutFlow  = totalPutVol  > 0 ? netPutFlow  / totalPutVol  : 0;

  // Combined directional signal:
  //   Aggressive call buying (>0) AND put selling (>0) = strongly bullish
  //   Aggressive put buying (<0) AND call selling (<0) = strongly bearish
  const rawSignal = normCallFlow - normPutFlow; // range roughly [-1, +1]
  const score = atan10(rawSignal, 0.15);

  const regime = rawSignal > 0.25 ? 'AGG_CALL_BUY'
               : rawSignal > 0.10 ? 'MILD_CALL_PREF'
               : rawSignal < -0.25 ? 'AGG_PUT_BUY'
               : rawSignal < -0.10 ? 'MILD_PUT_PREF'
               : 'BALANCED_FLOW';

  return {
    score:        clamp(score, -10, 10),
    available:    true,
    normCallFlow: +normCallFlow.toFixed(4),
    normPutFlow:  +normPutFlow.toFixed(4),
    rawSignal:    +rawSignal.toFixed(4),
    totalVol:     totalCallVol + totalPutVol,
    regime,
    detail: `callFlow=${(normCallFlow * 100).toFixed(1)}% putFlow=${(normPutFlow * 100).toFixed(1)}% [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. SKEW DELTA  (Cremers & Weinbaum 2010; Xing, Zhang & Zhao 2010)
// ─────────────────────────────────────────────────────────────────────────────
// "Deviations from Put-Call Parity and Stock Return Predictability"
// "What Does the Individual Option Volatility Smirk Tell Us About Future Equity Returns?"
//
// The CHANGE in IV skew predicts returns far better than the level.
// Steepening put skew (more negative ΔRR) → fear accumulating → contrarian bullish.
// Flattening put skew (less negative ΔRR) → complacency → bearish.
//
// Uses a module-level session cache (persists within a server process run).
// Returns unavailable on first call; fires from the second call onward.

const _skewHistory = []; // { ts, rr, slope } — populated each calculateBias call

function _updateSkewCache(rr, slope) {
  const ts   = Math.floor(Date.now() / 1000);
  // Use ET date to bucket readings — skew delta is a daily (session-to-session) measure.
  // Multiple intraday polls must update the same slot, not push duplicate entries.
  // Without this, the 10-slot ring fills within minutes and ΔRR is always ~0 (noise).
  const etOff = etOffsetHours(ts) * 3600;
  const date  = new Date((ts + etOff) * 1000).toISOString().slice(0, 10); // ET date

  if (_skewHistory.length > 0 && _skewHistory[_skewHistory.length - 1].date === date) {
    // Same session: overwrite with the latest reading (closing-price is most representative)
    _skewHistory[_skewHistory.length - 1] = { ts, date, rr: rr ?? 0, slope: slope ?? 0 };
    return;
  }
  _skewHistory.push({ ts, date, rr: rr ?? 0, slope: slope ?? 0 });
  // Retain up to 10 sessions (~2 trading weeks)
  if (_skewHistory.length > 10) _skewHistory.shift();
}

function skewDeltaSignal(currentRR, currentSlope) {
  // currentRR   = gex.rr25d.rr (25-delta risk reversal, e.g. -0.05 = -5% skew)
  // currentSlope = adv.ivSkewSlope.slope (OLS slope of IV vs moneyness)
  if (currentRR == null || currentSlope == null) {
    return { score: 0, available: false, detail: 'No skew inputs' };
  }

  // Push current reading into cache, then read the change
  _updateSkewCache(currentRR, currentSlope);

  if (_skewHistory.length < 2) {
    return { score: 0, available: false, detail: 'Building skew history (1 reading)' };
  }

  const oldest = _skewHistory[0];
  const latest = _skewHistory[_skewHistory.length - 1];
  const histDays = (latest.ts - oldest.ts) / 86400;

  // RR steepening: more negative = more put premium = more fear
  const rrDelta    = latest.rr    - oldest.rr;    // negative = put skew increased
  const slopeDelta = latest.slope - oldest.slope; // negative = steeper put slope

  // Contrarian: fear accumulating (rrDelta < 0) = eventually bullish
  // Fear fading (rrDelta > 0) = complacency building = bearish
  // Multiply rr by 100 to convert fraction to percentage points
  const rrPct = rrDelta * 100; // e.g. -0.02 → -2pp
  const combined = -(rrPct * 0.7 + slopeDelta * 10 * 0.3); // weighted: negative rrDelta = bullish
  const score = atan10(combined, 3.0); // ±3pp RR change = ±half signal

  const regime = rrPct < -4 ? 'STEEP_PUT_SKEW_SURGE'
               : rrPct < -1 ? 'PUT_SKEW_STEEPENING'
               : rrPct > +4 ? 'PUT_SKEW_COLLAPSING'
               : rrPct > +1 ? 'PUT_SKEW_FLATTENING'
               : 'STABLE_SKEW';

  return {
    score:     clamp(score, -10, 10),
    available: true,
    rrDelta:   +rrDelta.toFixed(4),
    rrDeltaPP: +rrPct.toFixed(2),
    slopeDelta: +slopeDelta.toFixed(3),
    histDays:  +histDays.toFixed(1),
    histN:     _skewHistory.length,
    regime,
    detail: `ΔRR=${rrPct > 0 ? '+' : ''}${rrPct.toFixed(1)}pp Δslope=${slopeDelta.toFixed(2)} over ${histDays.toFixed(0)}d [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 19. OPEX CYCLE SIGNAL
// ─────────────────────────────────────────────────────────────────────────────
// Ni, Pearson & Poteshman (2005): stock prices cluster near round-number strikes
// on option expiration dates (the "pinning" effect).
// Expiration week: charm/vanna decay → forced dealer unwind → predictable flows.
// Post-OPEX: gamma/delta slate resets → often directional follow-through.
//
// cal = getCalendarContext(nowTs) from modules/calendar.js

function opexCycleSignal(cal) {
  if (!cal) return { score: 0, available: false, detail: 'No calendar context' };

  let score = 0;
  let label = 'NO_OPEX_PRESSURE';

  if (cal.isQuadDay) {
    // Quad-witch day: maximum mechanical flow, extreme pin/unwind
    label = 'QUAD_WITCH_DAY';
    score = -2; // slight bearish: dealers unwind creates intraday chop/fade
  } else if (cal.daysToMonthlyOpex <= 0.5) {
    // Monthly OPEX day: charm/vanna collapse, strong pinning at strikes
    label = 'MONTHLY_OPEX_DAY';
    score = -1.5;
  } else if (cal.daysToWeeklyOpex <= 0.5) {
    // Weekly OPEX: more concentrated 0DTE gamma
    label = 'WEEKLY_OPEX_DAY';
    score = -1.0;
  } else if (cal.daysToMonthlyOpex <= 5.5) {
    // Expiration week: elevated charm decay, vol-crush, positive-gamma pinning.
    // ≤5.5 days covers Mon–Fri of the OPEX calendar week (OPEX closes 4PM Friday;
    // Sunday-evening checks can show ~5.1 days, so 5.5 is the robust boundary).
    // IV-bearish but NOT reliably price-bearish (Ni-Pearson-Poteshman document
    // pinning to strikes, not directional decline). Modest tilt only.
    label = cal.isNearQuad ? 'QUAD_WITCH_WEEK' : 'MONTHLY_OPEX_WEEK';
    score = -1.0; // reduced from -2.5: vol-crush ≠ price directionally bearish
  } else if (cal.daysSinceMonthlyOpex >= 0.5 && cal.daysSinceMonthlyOpex <= 5) {
    // True post-OPEX window: 1-5 calendar days after expiry.
    // Gamma/delta books reset → open interest rebuilds → typically bullish drift
    // as dealers sell new calls to establish the next cycle's pin structure.
    label = 'POST_OPEX_DRIFT';
    score = +2.0;
  } else if (cal.daysToWeeklyOpex <= 2) {
    // Within 2 days of weekly OPEX: mild 0DTE pinning effect
    label = 'WEEKLY_OPEX_APPROACHING';
    score = -0.5;
  }

  // Quad-witch amplifier: apply to the full OPEX week (≤5.5 days, same boundary as
  // the week-detection branch above). Previous ≤4 limit left Mon/Tue of quad week
  // unamplified while Wed–Fri were — an inconsistent boundary with no justification.
  if (cal.isNearQuad && !cal.isQuadDay) {
    score = clamp(score * 1.4, -10, 10);
  }

  return {
    score:           clamp(score, -10, 10),
    available:       true,
    daysToWeekly:    +cal.daysToWeeklyOpex.toFixed(1),
    daysToMonthly:   +cal.daysToMonthlyOpex.toFixed(1),
    isQuadMonth:     cal.isQuadMonth,
    isNearQuad:      cal.isNearQuad,
    label,
    detail: `${label} | weekly=${cal.daysToWeeklyOpex.toFixed(1)}d monthly=${cal.daysToMonthlyOpex.toFixed(1)}d${cal.isNearQuad ? ' [QUAD]' : ''}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 20. PRE-EVENT DRIFT
// ─────────────────────────────────────────────────────────────────────────────
// Lucca & Moench (2015): ~50bps of the entire equity risk premium is earned in
// the single 24-hour window before FOMC decisions — the largest single-day anomaly
// in all of equity finance.
//
// Also covers: CPI vol-crush, NFP pre-positioning, turn-of-month inflows,
// and day-of-week seasonality.
//
// cal = getCalendarContext(nowTs) from modules/calendar.js

function preEventDriftSignal(cal) {
  if (!cal) return { score: 0, available: false, detail: 'No calendar context' };

  let score = 0;
  const events = [];

  // ── FOMC ───────────────────────────────────────────────────────────────────
  if (cal.inPreFomcWindow) {
    // Lucca-Moench: average +0.49% equity return in pre-FOMC 24h
    score += 4.5;
    events.push('PRE_FOMC_DRIFT');
  }
  if (cal.inPostFomcCrush) {
    // Immediate post-decision (0-4h): IV collapse → short-vol positions relieved → bullish
    // This is the mechanical IV crush, not a directional prediction.
    score += 3.0;
    events.push('FOMC_VOL_CRUSH');
  }
  // NOTE: a 4-24h post-FOMC "fade" was previously coded here (-1.0) but is NOT
  // documented in Lucca-Moench (2015) — removed to avoid fabricated calibration.

  // ── CPI ────────────────────────────────────────────────────────────────────
  if (cal.inPreCpiWindow) {
    // Pre-CPI: mild risk-on positioning, compressed realized vol
    score += 1.5;
    events.push('PRE_CPI');
  }
  if (cal.inPostCpiCrush) {
    // Immediate post-CPI release: vega collapse → options decay → slight bullish
    score += 2.0;
    events.push('POST_CPI_VOL_CRUSH');
  }

  // ── NFP ────────────────────────────────────────────────────────────────────
  if (cal.inPreNFPWindow) {
    // Pre-NFP morning: light risk-on drift before 8:30 release
    score += 1.0;
    events.push('PRE_NFP');
  }

  // ── Turn-of-month (Ogden 1990) ─────────────────────────────────────────────
  if (cal.inTurnOfMonth) {
    score += cal.tomScore; // 1-3 depending on how close to month boundary
    events.push('TURN_OF_MONTH');
  }

  // ── Day-of-week seasonal ───────────────────────────────────────────────────
  score += cal.dowBias;

  const available = events.length > 0 || Math.abs(cal.dowBias) >= 0.3;
  const label = events.length > 0 ? events.join('+') : 'DOW_SEASONAL';

  return {
    score:         clamp(score, -10, 10),
    available,
    events,
    daysToFomc:    +cal.daysToFomc.toFixed(1),
    daysToCpi:     +cal.daysToCpi.toFixed(1),
    daysToNFP:     +cal.daysToNFP.toFixed(1),
    inTurnOfMonth: cal.inTurnOfMonth,
    dow:           cal.dow,
    dowBias:       +cal.dowBias.toFixed(2),
    label,
    detail: `${label} | FOMC ${cal.daysToFomc.toFixed(1)}d CPI ${cal.daysToCpi.toFixed(1)}d NFP ${cal.daysToNFP.toFixed(1)}d`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 21. VRP TERM STRUCTURE SIGNAL
// ─────────────────────────────────────────────────────────────────────────────
// Extends the single-point VRP with a term-structure slope (Park 2015; CBOE VVIX).
// VIX9D/VIX ratio: backwardation = near-term fear spiking > future fear → bearish.
// VIX/VIX3M slope: similar but on the 1M vs 3M horizon.
// VVIX: vol-of-vol. High VVIX = unstable IV regime → bearish for carry/MR strategies.
//
// Complements (does NOT replace) the existing vixTermStruct signal.
// vixTermStruct uses the raw contango/backwardation regime.
// vrpTermStruct measures the GRADIENT and VVIX stress level.

function vrpTermStructureSignal(vixData) {
  if (!vixData) return { score: 0, available: false, detail: 'No VIX data' };

  const vix9d = vixData.vix9d;
  const vix   = vixData.vix;
  const vix3m = vixData.vix3m;
  const vvix  = vixData.vvix;

  if (vix9d == null || vix == null || vix3m == null) {
    return { score: 0, available: false, detail: 'Incomplete VIX term structure for VRP-TS' };
  }

  // Front-to-spot slope: backwardation (positive) = near-term stress elevated
  const frontSlope = vix9d / vix   - 1; // positive = backwardation (bearish)
  // Spot-to-back slope: overall term structure gradient
  const backSlope  = vix   / vix3m - 1; // positive = backwardation

  // Combined term structure stress: average of both slopes
  const termStress = (frontSlope + backSlope) / 2;

  // VVIX regime: measures vol-of-vol (stability of the vol surface itself)
  // Normal: ~85–100. Stressed: >110. Crisis: >130.
  const vvixScore = vvix ? -(2 / Math.PI) * Math.atan((vvix - 95) / 20) * 4 : 0;

  // Combined score: backwardation = bearish, BUT extreme backwardation after a panic
  // spike is a mean-reversion setup (fear overextended → contrarian bullish).
  // Cap the bearish contribution at moderate backwardation; don't extrapolate
  // the bearish signal into extreme-spike territory where it reverses.
  // (Analogous to the CAPITULATION_SKEW carve-out in ivSkewSlopeSignal.)
  const termStressCapped = termStress > 0.12 ? 0.12 : termStress; // clamp beyond ~12%
  const rawScore = -(termStressCapped * 40) + vvixScore; // 12% → -4.8, not -∞
  const score = atan10(rawScore, 4);

  const regime = termStress > 0.10 ? 'STEEP_BACKWARDATION'
               : termStress > 0.03 ? 'MILD_BACKWARDATION'
               : termStress < -0.08 ? 'STEEP_CONTANGO'
               : termStress < -0.02 ? 'CONTANGO'
               : 'FLAT';

  return {
    score:       clamp(score, -10, 10),
    available:   true,
    vix9d:       +vix9d.toFixed(2),
    vix:         +vix.toFixed(2),
    vix3m:       +vix3m.toFixed(2),
    vvix:        vvix != null ? +vvix.toFixed(1) : null,
    frontSlope:  +frontSlope.toFixed(4),
    backSlope:   +backSlope.toFixed(4),
    regime,
    detail: `VIX9D/VIX=${frontSlope > 0 ? '+' : ''}${(frontSlope * 100).toFixed(1)}% VIX/VIX3M=${backSlope > 0 ? '+' : ''}${(backSlope * 100).toFixed(1)}% VVIX=${vvix?.toFixed(0) ?? 'n/a'} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 22. YIELD CURVE SIGNAL  (T10Y2Y + MOVE Index)
// ─────────────────────────────────────────────────────────────────────────────
// 10Y-2Y Treasury yield spread as recession/expansion indicator.
// MOVE index (Merrill Lynch / ICE Bond Volatility) as cross-market stress.
//
// macroData = { yieldSpread: { value }, yieldSpreadSeries: [...], move: number }
// from dataFetcher.fetchMacroData()

function yieldCurveSignal(macroData) {
  if (!macroData) return { score: 0, available: false, detail: 'No macro data' };

  const spread = macroData.yieldSpread?.value ?? macroData.yieldSpread ?? null;
  const series = macroData.yieldSpreadSeries ?? [];
  const move   = macroData.move ?? null; // MOVE index level

  if (spread == null || isNaN(spread)) {
    return { score: 0, available: false, detail: 'No T10Y2Y data' };
  }

  // ── Spread level score ─────────────────────────────────────────────────────
  // Deeply inverted: strong recession signal → very bearish for equities long-term
  // Steepening / positive: recovery phase → bullish
  let spreadScore;
  if      (spread < -1.2)  spreadScore = -8;
  else if (spread < -0.75) spreadScore = -5;
  else if (spread < -0.25) spreadScore = -2;
  else if (spread <  0.25) spreadScore =  0;
  else if (spread <  1.0)  spreadScore = +2;
  else if (spread <  2.0)  spreadScore = +3;
  else                     spreadScore = +4;

  // ── Momentum score: 5-session change in spread ─────────────────────────────
  let momentumScore = 0;
  if (series.length >= 6) {
    const prev5d = series[series.length - 6]?.value ?? spread;
    const delta5d = spread - prev5d;
    // Steepening (positive delta) = improving growth outlook = bullish
    momentumScore = atan10(delta5d, 0.20); // 20bp change = half signal
  }

  // ── MOVE index score ───────────────────────────────────────────────────────
  // MOVE < 80: bond market calm; 80-100: normal; 100-120: elevated; > 120: stress
  // High MOVE → bond volatility elevated → risk-off signal → bearish for equities
  let moveScore = 0;
  if (move != null && !isNaN(move)) {
    moveScore = -(2 / Math.PI) * Math.atan((move - 95) / 22) * 4; // ±4 max
  }

  const rawScore = spreadScore * 0.55 + momentumScore * 0.25 + moveScore * 0.20;
  const score = clamp(rawScore, -10, 10);

  const regime = spread < -0.75 ? 'DEEPLY_INVERTED'
               : spread < -0.10 ? 'INVERTED'
               : spread <  0.50 ? 'FLAT_CURVE'
               : spread <  1.50 ? 'NORMAL_CURVE'
               : 'STEEP_CURVE';

  return {
    score,
    available:    true,
    t10y2y:       +spread.toFixed(3),
    move:         move != null ? +move.toFixed(1) : null,
    regime,
    detail: `T10Y2Y=${spread.toFixed(2)}% [${regime}]${move != null ? ` MOVE=${move.toFixed(0)}` : ''}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 23. CROSS-ASSET LEAD-LAG  (Hou 2007; practitioner credit/bond lead)
// ─────────────────────────────────────────────────────────────────────────────
// Bonds (TLT) and credit (HYG) often lead equities by 1-5 days on daily bars.
// When credit or bond markets diverge from equity, equities tend to follow.
// Uses daily multiAsset bars (already available in bias.js).
//
// Signal: compute lagged Pearson correlation between TLT[t-1]/HYG[t-1] and SPY[t]
// over the last 20 sessions. If correlation is positive and the lagged asset was
// rising, project equity continuation (bullish) — and vice versa.

function leadLagSignal(multiAsset) {
  if (!multiAsset) return { score: 0, available: false, detail: 'No multi-asset data' };

  const tltBars = multiAsset['TLT'];
  const hygBars = multiAsset['HYG'];
  const spyBars = multiAsset['SPY'] || multiAsset['QQQ'];

  if (!tltBars?.length || !hygBars?.length || !spyBars?.length) {
    return { score: 0, available: false, detail: 'Need TLT + HYG + SPY daily bars' };
  }

  const lookback = Math.min(25, tltBars.length - 2, hygBars.length - 2, spyBars.length - 2);
  if (lookback < 8) return { score: 0, available: false, detail: 'Insufficient lookback for lead-lag' };

  // Compute log returns for each asset
  const mkRet = (bars, lb) => {
    const slice = bars.slice(-lb - 2);
    const rets  = [];
    for (let i = 1; i < slice.length; i++) {
      if (slice[i].close > 0 && slice[i - 1].close > 0) {
        rets.push(Math.log(slice[i].close / slice[i - 1].close));
      }
    }
    return rets;
  };

  const spyRets = mkRet(spyBars, lookback);
  const tltRets = mkRet(tltBars, lookback);
  const hygRets = mkRet(hygBars, lookback);

  // Align lengths
  const n = Math.min(spyRets.length, tltRets.length, hygRets.length);
  if (n < 6) return { score: 0, available: false, detail: 'Too few aligned returns' };

  // Lagged correlation: does tlt[t-1] predict spy[t]?
  const spyNow  = spyRets.slice(1, n);  // t=1..n
  const tltLag1 = tltRets.slice(0, n - 1); // t-1
  const hygLag1 = hygRets.slice(0, n - 1);

  const pearson = (x, y) => {
    const len  = Math.min(x.length, y.length);
    const mx   = x.slice(-len).reduce((s, v) => s + v, 0) / len;
    const my   = y.slice(-len).reduce((s, v) => s + v, 0) / len;
    const num  = x.slice(-len).reduce((s, v, i) => s + (v - mx) * (y.slice(-len)[i] - my), 0);
    const sdx  = Math.sqrt(x.slice(-len).reduce((s, v) => s + (v - mx) ** 2, 0));
    const sdy  = Math.sqrt(y.slice(-len).reduce((s, v) => s + (v - my) ** 2, 0));
    return sdx * sdy > 0 ? num / (sdx * sdy) : 0;
  };

  const corrTLT = pearson(tltLag1, spyNow);
  const corrHYG = pearson(hygLag1, spyNow);

  // Most recent lagged direction: use the last completed return (t-1), which is
  // the leading predictor for today's equity return (t). That is index length-1,
  // matching the tltLag1 = tltRets.slice(0, n-1) convention used in the correlation.
  const tltDir = tltRets[tltRets.length - 1] > 0 ? 1 : -1; // most recent TLT return
  const hygDir = hygRets[hygRets.length - 1] > 0 ? 1 : -1; // most recent HYG return

  // Signal: if correlation is reliably positive AND yesterday's leader was going up → bullish
  const minCorr = 0.20; // require meaningful correlation before using signal
  const tltSignal = Math.abs(corrTLT) > minCorr ? tltDir * corrTLT : 0;
  const hygSignal = Math.abs(corrHYG) > minCorr ? hygDir * corrHYG : 0;

  // HYG weighted more: credit markets are a more direct leading indicator of equity risk
  const rawScore = (tltSignal * 0.35 + hygSignal * 0.65) * 10;
  const score = atan10(rawScore, 3.0);

  // Use Math.abs(corr) > minCorr to detect both positive and inverse leads.
  // Then check the SIGN of hygDir * corrHYG to determine direction:
  //   positive correlation + rising HYG  → bullish
  //   negative correlation + rising HYG  → bearish (inverse lead)
  const hygLeads = Math.abs(corrHYG) > minCorr;
  const tltLeads = Math.abs(corrTLT) > minCorr;
  const hygProjection = hygDir * corrHYG; // positive = bullish for equity
  const tltProjection = tltDir * corrTLT;

  const regime = hygLeads && hygProjection > 0 ? 'CREDIT_LEADING_BULL'
               : hygLeads && hygProjection < 0 ? 'CREDIT_LEADING_BEAR'
               : tltLeads && tltProjection > 0 ? 'BONDS_LEADING_BULL'
               : tltLeads && tltProjection < 0 ? 'BONDS_LEADING_BEAR'
               : 'NO_CLEAR_LEAD';

  return {
    score:   clamp(score, -10, 10),
    available: true,
    corrTLT: +corrTLT.toFixed(3),
    corrHYG: +corrHYG.toFixed(3),
    tltDir,
    hygDir,
    regime,
    detail: `corrHYG=${corrHYG.toFixed(2)} tltDir=${tltDir > 0 ? '↑' : '↓'} hygDir=${hygDir > 0 ? '↑' : '↓'} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 24. RELATIVE STRENGTH  (NQ/ES + small-cap breadth)
// ─────────────────────────────────────────────────────────────────────────────
// QQQ/SPY ratio momentum as a proxy for NQ/ES relative performance.
// Strong QQQ relative to SPY: tech/growth leadership → risk-on environment.
// IWM/SPY relative strength: small-cap outperformance → broad risk appetite.
// Growth leadership is historically a precursor to index strength; defensive
// rotation is a precursor to broader weakness.

function relativeStrengthSignal(multiAsset) {
  if (!multiAsset) return { score: 0, available: false, detail: 'No multi-asset data' };

  const qqq = multiAsset['QQQ'];
  const spy = multiAsset['SPY'];
  const iwm = multiAsset['IWM'];

  if (!qqq?.length || !spy?.length) {
    return { score: 0, available: false, detail: 'Need QQQ + SPY for relative strength' };
  }

  const minLen = Math.min(qqq.length, spy.length, 25);
  if (minLen < 6) return { score: 0, available: false, detail: 'Insufficient bars for RS' };

  const qC = qqq.slice(-minLen).map(b => b.close);
  const sC = spy.slice(-minLen).map(b => b.close);

  // NQ/ES ratio via QQQ/SPY proxy
  const ratioNow  = qC[qC.length - 1] / sC[sC.length - 1];
  const ratio5d   = qC.length >= 6  ? qC[qC.length - 6]  / sC[sC.length - 6]  : ratioNow;
  const ratio20d  = qC.length >= 21 ? qC[qC.length - 21] / sC[sC.length - 21] : ratioNow;

  const mom5d  = ratioNow / ratio5d  - 1; // positive = QQQ outperforming → risk-on
  const mom20d = ratioNow / ratio20d - 1;

  // IWM/SPY (small-cap vs large-cap risk appetite)
  // IMPORTANT: use a dedicated 22-bar SPY slice (not sC which may be shorter than 22)
  // so IWM and SPY denominators cover the exact same horizon.
  let iwmScore = 0;
  if (iwm?.length >= 22 && spy?.length >= 22) {
    const iC        = iwm.slice(-22).map(b => b.close);
    const spyFor22  = spy.slice(-22).map(b => b.close); // independent, full 22-bar slice
    const iwmRatioNow = iC[iC.length - 1]       / spyFor22[spyFor22.length - 1];
    const iwmRatio20d = iC[0]                    / spyFor22[0];
    const iwmMom20d   = iwmRatioNow / iwmRatio20d - 1;
    iwmScore = iwmMom20d * 20; // 5% small-cap outperform = +1 raw score
  }

  const rawScore = mom5d * 20 + mom20d * 12 + iwmScore * 0.3;
  const score = atan10(rawScore, 3.0);

  const regime = mom5d > 0.03 && iwmScore > 0 ? 'BROAD_RISK_ON'
               : mom5d > 0.02              ? 'TECH_GROWTH_LEAD'
               : mom5d < -0.03             ? 'DEFENSIVE_ROTATION'
               : mom5d < -0.01             ? 'VALUE_ROTATION'
               : 'NEUTRAL_RS';

  return {
    score:    clamp(score, -10, 10),
    available: true,
    nqEsMom5d:  +mom5d.toFixed(4),
    nqEsMom20d: +mom20d.toFixed(4),
    iwmScore:   +iwmScore.toFixed(3),
    regime,
    detail: `NQ/ES 5d=${(mom5d * 100).toFixed(1)}% 20d=${(mom20d * 100).toFixed(1)}% [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 25. ZERO-DTE GEX SIGNAL
// ─────────────────────────────────────────────────────────────────────────────
// 0DTE options now represent >50% of SPX daily option volume (CBOE 2023).
// Their GEX behaves fundamentally differently from multi-day options:
//   — Gamma decays to a near-delta-function near expiry → explosive pin/puke
//   — Concentrated strike clustering creates violent intraday support/resistance
//   — Positive 0DTE GEX near spot = pinning force; negative = amplification
//
// Complements the daily-chain GEX (which averages across all expirations)
// with a same-day-only computation that captures intraday mechanics.

function zeroDteGexSignal(chain, spot) {
  if (!chain || !spot || spot <= 0) {
    return { score: 0, available: false, detail: 'No chain for 0DTE GEX' };
  }

  const now = Date.now() / 1000;
  const cutoff24h = now + 24 * 3600; // contracts expiring within 24h

  // Filter for same-day / next-day expiry only
  const zdCalls = chain.calls.filter(c => c.expiration <= cutoff24h && c.expiration > now);
  const zdPuts  = chain.puts.filter( p => p.expiration <= cutoff24h && p.expiration > now);

  if (zdCalls.length + zdPuts.length < 2) {
    return { score: 0, available: false, detail: 'No 0DTE contracts available' };
  }

  // Compute net GEX for 0DTE contracts only
  // netGEX = gamma × OI × 100 × spot (simplified; calls positive, puts negative)
  // Using the existing BSM greeks helper from the top of advanced.js
  let zdNetGEX = 0;
  let zdContracts = 0;
  let maxCallStrike = null, maxPutStrike = null;
  let maxCallGEX = 0, maxPutGEX = 0;

  const processZD = (contract, type) => {
    if (!contract.openInterest || contract.openInterest < 1) return;
    const T    = Math.max((contract.expiration - now) / (365 * 86400), 0.0001);
    const iv   = contract.impliedVolatility > 0.01 ? contract.impliedVolatility : 0.25;
    const g    = _bsGreeks(spot, contract.strike, RISK_FREE_DPCR, iv, T, type);
    const oi   = contract.openInterest;
    // Cap per-contract gamma: BSM gamma ∝ 1/√T blows up in the final minutes
    // before expiry. SPY ATM gamma is rarely above 0.15 on normal trading days;
    // cap at 0.30 to suppress the terminal spike without affecting normal hours.
    const gammaCapped = Math.min(g.gamma, 0.30);
    // Use the same GEX formula as gex.js: gamma × OI × 100 × spot² × 0.01
    // = dollar GEX per 1% move (not just gamma × OI × 100 × spot which
    //   gives different units and a 1/(spot×0.01) scaling error vs the main profile).
    const gex  = gammaCapped * oi * 100 * spot * spot * 0.01;
    const sign = type === 'call' ? 1 : -1;
    zdNetGEX  += sign * gex;
    zdContracts++;
    if (type === 'call' && gex > maxCallGEX) { maxCallGEX = gex; maxCallStrike = contract.strike; }
    if (type === 'put'  && gex > maxPutGEX)  { maxPutGEX  = gex; maxPutStrike  = contract.strike; }
  };

  zdCalls.forEach(c => processZD(c, 'call'));
  zdPuts.forEach( p => processZD(p, 'put'));

  if (zdContracts < 2) return { score: 0, available: false, detail: 'Insufficient 0DTE gamma data' };

  // Positive 0DTE net GEX near spot → pinning → suppress intraday range → slight bearish for MR
  // Negative 0DTE net GEX → amplification → explosive moves → bearish for all strategies
  // The score is: positive GEX = neutral to slight bearish (pinning kills premiums);
  //               negative GEX near EOD = very bearish (gamma puke cascade risk)
  // Thresholds calibrated for the corrected gex.js-consistent formula.
  // Typical SPY 0DTE ATM (gamma≈0.05, OI≈5000, spot≈500):
  //   0.05 * 5000 * 100 * 500 * 500 * 0.01 = $625M per strike → use 2.5e9 as atan scale.
  const zdScore = -(2 / Math.PI) * Math.atan(zdNetGEX / 2.5e9) * 10;

  const regime = zdNetGEX > 5e9   ? 'STRONG_0DTE_PIN'
               : zdNetGEX > 1e9   ? 'MILD_0DTE_PIN'
               : zdNetGEX < -5e9  ? 'NEGATIVE_0DTE_AMPLIFY'
               : zdNetGEX < -1e9  ? 'MILD_0DTE_AMPLIFY'
               : '0DTE_NEUTRAL';

  return {
    score:        clamp(zdScore, -10, 10),
    available:    true,
    zdNetGEX:     +zdNetGEX.toFixed(0),
    zdContracts,
    maxCallStrike,
    maxPutStrike,
    regime,
    detail: `0DTE netGEX=${(zdNetGEX / 1e9).toFixed(2)}B n=${zdContracts} [${regime}]`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  openingRangeSignal,
  standardErrorChannel,
  garchVolatilitySignal,
  entropySignal,
  zScoreMeanReversion,
  vpaDivergence,
  intradaySeasonality,
  mrsmSignal,
  postNewsBehavior,
  skewnessKurtosisSignal,
  fatTailsSignal,
  nonNormalDistSignal,
  cltConvergenceSignal,
  ivSkewSlopeSignal,
  straddleExpectedMoveSignal,
  varianceRatioSignal,
  volSurfaceButterflySignal,
  cvdDivergenceSignal,
  amihudIlliquiditySignal,
  deltaWeightedPCRSignal,
  // New signals (batch 2)
  downsideSemivarianceSignal,
  vpinSignal,
  signedOptionFlowSignal,
  skewDeltaSignal,
  opexCycleSignal,
  preEventDriftSignal,
  vrpTermStructureSignal,
  yieldCurveSignal,
  leadLagSignal,
  relativeStrengthSignal,
  zeroDteGexSignal,
};
