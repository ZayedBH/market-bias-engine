'use strict';

// ── Yang-Zhang Volatility Estimator ──────────────────────────────────────────
// Yang & Zhang (2000): Drift-Independent Volatility Estimation Based on OHLC
// Accounts for overnight jumps — most accurate OHLC-based estimator
// σ²_YZ = σ²_overnight + k × σ²_open_close + (1-k) × σ²_RS
// where k = 0.34 / (1.34 + (n+1)/(n-1)) is optimal weighting

function yangZhangVol(bars, window = 20) {
  // bars: array of { open, high, low, close } objects
  if (bars.length < window + 1) return null;

  const slice = bars.slice(-(window + 1));
  const results = [];

  for (let i = 1; i < slice.length; i++) {
    const prev  = slice[i - 1];
    const curr  = slice[i];

    // Overnight: use adjClose for prev so dividend ex-dates don't inflate the gap.
    // adjOpen = open × (adjClose/close) approximates the split-and-dividend-adjusted open.
    // Intraday components (h, l, c) are unaffected by dividends — use raw prices.
    const prevAdjClose = prev.adjClose ?? prev.close;
    const adjFactor    = (curr.adjClose && curr.close) ? curr.adjClose / curr.close : 1;
    const adjOpen      = curr.open * adjFactor;
    const o = Math.log(adjOpen / prevAdjClose);    // overnight: dividend-adjusted
    const c = Math.log(curr.close / curr.open);    // open-to-close return
    const h = Math.log(curr.high  / curr.open);
    const l = Math.log(curr.low   / curr.open);
    const rs = h * (h - c) + l * (l - c);         // Rogers-Satchell (intraday, no div effect)

    results.push({ o, c, rs });
  }

  const n = results.length;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));

  const meanO = results.reduce((s, r) => s + r.o, 0) / n;
  const meanC = results.reduce((s, r) => s + r.c, 0) / n;

  const varO  = results.reduce((s, r) => s + (r.o - meanO) ** 2, 0) / (n - 1);
  const varC  = results.reduce((s, r) => s + (r.c - meanC) ** 2, 0) / (n - 1);
  const varRS = results.reduce((s, r) => s + r.rs, 0) / n;

  const varYZ = varO + k * varC + (1 - k) * varRS;
  return Math.sqrt(Math.max(0, varYZ) * 252) * 100; // annualized %
}

// ── Garman-Klass Estimator ────────────────────────────────────────────────────
// Garman & Klass (1980): original range-based estimator
// σ²_GK = 0.5(ln H/L)² - (2ln2-1)(ln C/O)²
function garmanKlassVol(bars, window = 20) {
  if (bars.length < window) return null;
  const slice = bars.slice(-window);
  const c = Math.log(2);

  const gk = slice.map(b => {
    const hl = Math.log(b.high / b.low);
    const co = Math.log(b.close / b.open);
    return 0.5 * hl ** 2 - (2 * c - 1) * co ** 2;
  });

  const meanGK = gk.reduce((s, v) => s + v, 0) / window;
  return Math.sqrt(Math.max(0, meanGK) * 252) * 100;
}

// ── Close-to-close realized vol ───────────────────────────────────────────────
function realizedVol(closes, window = 20) {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const returns = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

// ── Rolling realized vol series ───────────────────────────────────────────────
function rollingRealizedVol(closes, window = 20) {
  const out = [];
  for (let i = window; i <= closes.length; i++) {
    out.push(realizedVol(closes.slice(i - window - 1, i), window));
  }
  return out;
}

// ── Volatility Risk Premium ───────────────────────────────────────────────────
// VRP = IV - RV  (implied minus realized)
// Positive VRP: options overpriced → mean-reversion expected
// Negative VRP: options cheap → breakout/trend likely
// Bollerslev, Tauchen & Zhou (2009): VRP predicts next-week S&P returns
function computeVRP(bars, vixCurrent, window = 20) {
  const closes = bars.map(b => b.close);
  const rv = yangZhangVol(bars, window);
  if (!rv) return null;

  const iv  = vixCurrent; // VIX is 30d implied vol annualized
  const vrp = iv - rv;

  // Rolling mean and std for z-score
  const rvSeries = rollingRealizedVol(closes, window).filter(v => v !== null);
  const ivProxy  = vixCurrent; // static VIX as IV
  const vrpSeries = rvSeries.map(r => ivProxy - r);

  const mean = vrpSeries.reduce((s, v) => s + v, 0) / vrpSeries.length;
  const std  = Math.sqrt(vrpSeries.reduce((s, v) => s + (v - mean) ** 2, 0) / vrpSeries.length);
  const vrpZscore = std > 0 ? (vrp - mean) / std : 0;

  let signal = 0, interpretation = 'NEUTRAL';
  if (vrp > 3) { signal = 1; interpretation = 'RANGE_DAY_LIKELY'; }        // options rich → MR
  else if (vrp < -2) { signal = -1; interpretation = 'BREAKOUT_LIKELY'; }  // options cheap → trend

  // Positive VRP = options rich = mild bullish bias (sellers winning, risk premia elevated)
  const score = Math.max(-5, Math.min(5, vrp / 3));

  return {
    rv,
    iv,
    vrp,
    vrpZscore,
    signal,
    interpretation,
    score,
    gkVol: garmanKlassVol(bars, window),
  };
}

// ── VIX term structure signal ─────────────────────────────────────────────────
function computeVIXTermScore(vixData) {
  const { vix9d, vix, vix3m, termRatio, contango } = vixData;

  if (!vix9d || !vix) return { score: 0, regime: 'UNKNOWN' };

  // Contango (VIX9D < VIX) = normal backwardation = slightly bullish
  // Backwardation (VIX9D > VIX) = stress = bearish
  const ratio = vix9d / vix; // < 1 = contango, > 1 = backwardation

  let score = 0;
  let regime = 'CONTANGO';

  if (ratio < 0.85) { score = 3; regime = 'DEEP_CONTANGO'; }       // very bullish
  else if (ratio < 0.95) { score = 1; regime = 'CONTANGO'; }        // mild bullish
  else if (ratio < 1.05) { score = 0; regime = 'FLAT'; }            // neutral
  else if (ratio < 1.15) { score = -2; regime = 'BACKWARDATION'; }  // bearish
  else { score = -4; regime = 'DEEP_BACKWARDATION'; }               // very bearish stress

  // VVIX spike check
  const vvix = vixData.vvix;
  if (vvix && vvix > 130) score -= 1; // extra stress if vol-of-vol elevated

  return { score: Math.max(-10, Math.min(10, score)), regime, ratio, vix9d, vix, vix3m };
}

module.exports = { yangZhangVol, garmanKlassVol, realizedVol, rollingRealizedVol, computeVRP, computeVIXTermScore };
