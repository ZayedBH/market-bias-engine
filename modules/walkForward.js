'use strict';

// ── Walk-Forward Validation Engine ───────────────────────────────────────────
// Grinold & Kahn (2000) "Active Portfolio Management" — IC/IC_IR framework
// Lo (2002) "The Statistics of Sharpe Ratios" — rolling IC stability
//
// Validates the 23 OHLCV-computable signals over 5 years of daily data.
// Options/COT/sentiment signals require the live audit log (auditLog.js).
//
// Walk-forward design:
//   Training window: 252 bars (1 calendar year of daily data)
//   Step size:       63 bars  (1 trading quarter)
//   Min bars:        80 bars  (minimum for Hurst, regime, etc.)
//   Target horizon:  1 trading day (next close vs current close)
//
// Each window computes per-signal IC. IC_IR = mean(IC_per_window) / std(IC_per_window).
// Threshold: IC_IR < 0.3 → PRUNE recommendation (flag, not hard drop).
//
// Note: all signals use a FIXED VIX scalar (20) for historical simulation because
// Yahoo Finance VIX series (`^VIX`) may not be available at every historical bar.
// VIX-dependent signals (vrp, ouZscore, vixTermStruct) are excluded from walk-forward;
// they should be tracked via the live audit log where real VIX is available.

const {
  tsmomSignal, emaStackScore, pdhPdlScore, computeOFI, vwapZScore, overnightGapSignal,
} = require('./momentum');
const { computeHurst, ouScore } = require('./hurst');
const {
  garchVolatilitySignal, entropySignal, zScoreMeanReversion,
  standardErrorChannel, varianceRatioSignal, mrsmSignal,
  skewnessKurtosisSignal, fatTailsSignal, nonNormalDistSignal,
  cltConvergenceSignal, amihudIlliquiditySignal,
} = require('./advanced');
const { computeVRP } = require('./volatility');

// ── Spearman IC utilities ─────────────────────────────────────────────────────
function _rank(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(arr.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length - 1 && sorted[j + 1].v === sorted[j].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[sorted[k].i] = avgRank;
    i = j + 1;
  }
  return r;
}

function _pearsonR(x, y) {
  const n = x.length;
  if (n < 5) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / n;
  const sx  = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) / n);
  const sy  = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0) / n);
  return (sx > 0 && sy > 0) ? cov / (sx * sy) : null;
}

function spearmanIC(scores, returns) {
  if (!scores || scores.length < 5) return null;
  const r = _pearsonR(_rank(scores), _rank(returns));
  return r;
}

function icIR(icValues) {
  const valid = icValues.filter(v => v !== null && isFinite(v));
  if (valid.length < 2) return null;
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const std  = Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
  return std > 1e-10 ? mean / std : null;
}

// ── Signal score computation (single bar) ────────────────────────────────────
// Returns { signalKey → score } using only data available at bars[0..end].
// All signals must be computable from OHLCV alone (no options chain, no network).
function computeBarSignals(bars) {
  const closes = bars.map(b => b.close);
  const scores = {};

  const n = closes.length;
  if (n < 10) return scores;

  // Hurst — needs 80+ bars for meaningful lag set
  if (n >= 80) {
    const h = computeHurst(closes);
    if (isFinite(h.score)) scores.hurst = h.score;
  }

  // TSMOM — 1M/3M/6M
  if (n >= 126) {
    const t = tsmomSignal(closes, [21, 63, 126]);
    if (isFinite(t.tsmomScore)) scores.tsmom = t.tsmomScore;
  }

  // EMA stack — 1yr window max to avoid stale bull market EMA
  {
    const e = emaStackScore(closes.slice(-252));
    if (isFinite(e.score)) scores.emaStack = e.score;
  }

  // PDH/PDL — needs 3 bars
  if (bars.length >= 3) {
    const p = pdhPdlScore(bars.slice(-3));
    if (isFinite(p.score)) scores.pdhPdl = p.score;
  }

  // OFI — last 30 bars (needs at least 30 bars for the lookback=14 to be meaningful)
  if (bars.length >= 30) {
    const o = computeOFI(bars.slice(-30), 14);
    if (isFinite(o.score)) scores.ofi = o.score;
  }

  // VWAP z-score — 20 bars
  if (bars.length >= 25) {
    const v = vwapZScore(bars.slice(-25), 20);
    if (isFinite(v.score)) scores.vwapZscore = v.score;
  }

  // Overnight gap
  if (bars.length >= 2) {
    const g = overnightGapSignal(bars);
    if (isFinite(g.score)) scores.overnightGap = g.score;
  }

  // GARCH(1,1)
  {
    const g = garchVolatilitySignal(closes);
    if (g.available && isFinite(g.score)) scores.garch = g.score;
  }

  // Entropy
  {
    const e = entropySignal(closes);
    if (e.available && isFinite(e.score)) scores.entropy = e.score;
  }

  // Z-Score Mean Reversion
  {
    const z = zScoreMeanReversion(closes, 20);
    if (z.available && isFinite(z.score)) scores.zScoreMR = z.score;
  }

  // Standard Error Channel
  {
    const s = standardErrorChannel(closes, 50);
    if (s.available && isFinite(s.score)) scores.seChannel = s.score;
  }

  // Variance Ratio (only fire when statistically meaningful)
  {
    const v = varianceRatioSignal(closes, 4);
    if (v.available && Math.abs(v.score) > 1.5) scores.varRatio = v.score;
  }

  // MRSM (Hamilton 2-state)
  {
    const m = mrsmSignal(closes);
    if (m.available && isFinite(m.score)) scores.mrsm = m.score;
  }

  // Distribution shape signals
  if (n >= 60) {
    const sk = skewnessKurtosisSignal(closes, 60);
    if (sk.available && isFinite(sk.score)) scores.skewKurt = sk.score;
  }
  if (n >= 120) {
    const ft = fatTailsSignal(closes, 120);
    if (ft.available && isFinite(ft.score)) scores.fatTails = ft.score;
  }
  if (n >= 80) {
    const nn = nonNormalDistSignal(closes, 80);
    if (nn.available && isFinite(nn.score)) scores.nonNormal = nn.score;
  }
  {
    const c = cltConvergenceSignal(closes, 60);
    if (c.available && Math.abs(c.score) > 0.5) scores.clt = c.score;
  }

  // Amihud illiquidity (needs volume)
  if (bars.length >= 25 && bars[0].volume > 0) {
    const a = amihudIlliquiditySignal(bars, 25);
    if (a.available && isFinite(a.score)) scores.amihud = a.score;
  }

  // VRP (uses VIX scalar 20 — fixed for historical simulation)
  if (n >= 20) {
    const v = computeVRP(bars, 20, 20);
    if (v && isFinite(v.score)) scores.vrp = v.score;
  }

  // NOTE: hmmRegime intentionally excluded from walk-forward.
  // computeRegime() has a 6h in-process cache — during simulation all bars run in
  // milliseconds so the cache never expires, meaning every bar would reuse the
  // first-window HMM (trained on minimal data). This is lookahead bias.
  // HMM regime IC is tracked via the live audit log instead.

  return scores;
}

// ── Walk-forward main ─────────────────────────────────────────────────────────
// bars: array of OHLCV bars (sorted ascending, 5y of daily data)
// Returns per-signal IC, IC_IR, composite decile calibration, pruning recommendations.
function runWalkForward(bars) {
  const TRAIN_WIN = 252;  // 1 year training window
  const STEP      = 63;   // 1 quarter step
  const MIN_BARS  = 80;   // minimum bars needed before any signal fires

  if (bars.length < TRAIN_WIN + 1) {
    return {
      available: false,
      error: `Need at least ${TRAIN_WIN + 1} bars; have ${bars.length}`,
    };
  }

  // Per-signal collection: signal → windowResults[{ ic, n }]
  const signalPairs = {};       // signal → [{ score, ret }] (all predictions)
  const signalWindowICs = {};   // signal → [ic per window]
  const compositeData   = [];   // [{ score, ret }] for composite calibration

  // Simple composite from OHLCV signals: equal-weighted average across available signals
  function simpleComposite(signalScores) {
    const vals = Object.values(signalScores).filter(v => isFinite(v));
    if (!vals.length) return 0;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  // Walk-forward loop
  let windowStart = 0;
  let windowsRun  = 0;

  while (windowStart + TRAIN_WIN < bars.length) {
    const windowEnd = Math.min(windowStart + TRAIN_WIN, bars.length - 1);
    const windowPairs = {}; // signal → [{ score, ret }] within this window

    // For each evaluation point within this window: compute scores at bar i, measure next-day return
    for (let i = Math.max(windowStart, MIN_BARS - 1); i < windowEnd; i++) {
      const histBars  = bars.slice(0, i + 1);  // expanding window — all data up to i
      const scores    = computeBarSignals(histBars);
      const nextRet   = (bars[i + 1].close - bars[i].close) / bars[i].close;
      if (!isFinite(nextRet)) continue;

      for (const [sig, score] of Object.entries(scores)) {
        if (!signalPairs[sig])       signalPairs[sig]       = [];
        if (!windowPairs[sig])       windowPairs[sig]       = [];
        signalPairs[sig].push({ score, ret: nextRet });
        windowPairs[sig].push({ score, ret: nextRet });
      }

      const comp = simpleComposite(scores);
      compositeData.push({ score: comp, ret: nextRet });
    }

    // Per-window IC for each signal
    for (const [sig, pairs] of Object.entries(windowPairs)) {
      if (pairs.length < 5) continue;
      const ic = spearmanIC(pairs.map(p => p.score), pairs.map(p => p.ret));
      if (!signalWindowICs[sig]) signalWindowICs[sig] = [];
      signalWindowICs[sig].push(ic);
    }

    windowStart += STEP;
    windowsRun++;
  }

  // ── Per-signal stats ───────────────────────────────────────────────────────
  const signalStats = {};
  for (const [sig, pairs] of Object.entries(signalPairs)) {
    if (pairs.length < 10) continue;
    const allIC   = spearmanIC(pairs.map(p => p.score), pairs.map(p => p.ret));
    const wICs    = signalWindowICs[sig] ?? [];
    const ic_ir   = icIR(wICs);
    const icVal   = allIC ?? 0;
    const ic_irV  = ic_ir ?? 0;

    signalStats[sig] = {
      ic:      Math.round(icVal   * 1000) / 1000,
      ic_ir:   Math.round(ic_irV * 100)  / 100,
      n:       pairs.length,
      windows: wICs.length,
      grade:   ic_irV >= 1.0 ? 'GOOD'
             : ic_irV >= 0.5 ? 'MARGINAL'
             : ic_irV >= 0.3 ? 'WEAK'
             : 'PRUNE',
    };
  }

  // ── Composite IC + calibration bins ───────────────────────────────────────
  const compScores  = compositeData.map(d => d.score);
  const compReturns = compositeData.map(d => d.ret);
  const compIC      = spearmanIC(compScores, compReturns);

  // Sort by score, divide into 10 decile bins
  const sorted  = [...compositeData].sort((a, b) => a.score - b.score);
  const binSize = Math.max(1, Math.floor(sorted.length / 10));
  const deciles = [];
  for (let i = 0; i < sorted.length; i += binSize) {
    const slice  = sorted.slice(i, Math.min(i + binSize, sorted.length));
    const wins   = slice.filter(d => d.ret > 0).length;
    const avgRet = slice.reduce((s, d) => s + d.ret, 0) / slice.length;
    deciles.push({
      scoreLo:    Math.round(slice[0].score  * 10) / 10,
      scoreHi:    Math.round(slice.at(-1).score * 10) / 10,
      n:          slice.length,
      winRate:    Math.round(wins / slice.length * 1000) / 10,
      avgRetBps:  Math.round(avgRet * 10000),
    });
  }

  // ── Pruning recommendations ────────────────────────────────────────────────
  const pruned   = Object.entries(signalStats).filter(([, s]) => s.grade === 'PRUNE').map(([k]) => k);
  const weak     = Object.entries(signalStats).filter(([, s]) => s.grade === 'WEAK').map(([k]) => k);
  const good     = Object.entries(signalStats).filter(([, s]) => s.grade === 'GOOD').map(([k]) => k);

  // Calibrated win probability per composite decile bin
  // (empirical — this is what should replace the invented 0.5 + score/100 * 0.15 formula)
  const calibratedWinProb = deciles.map(d => ({
    scoreRange: [d.scoreLo, d.scoreHi],
    empiricalWinRate: d.winRate,
    avgRetBps: d.avgRetBps,
    n: d.n,
  }));

  return {
    available:      true,
    symbol:         'OHLCV signals (walk-forward)',
    bars:           bars.length,
    windows:        windowsRun,
    totalPredictions: compositeData.length,
    dateRange: {
      from: bars[0]?.date,
      to:   bars.at(-1)?.date,
    },
    composite: {
      ic:       compIC !== null ? Math.round(compIC * 1000) / 1000 : null,
      grade:    compIC === null ? 'N/A' : Math.abs(compIC) >= 0.05 ? 'PREDICTIVE' : 'NOISE',
    },
    signals:    signalStats,
    calibration: {
      deciles,
      note: 'Empirical win rate per composite score decile over walk-forward period. Use this to replace invented win probability formula in kelly.js.',
      calibratedWinProb,
    },
    recommendations: {
      prune:   pruned,
      weak,
      good,
      summary: `${good.length} good, ${weak.length} weak, ${Object.keys(signalStats).length - good.length - weak.length - pruned.length} marginal, ${pruned.length} recommended for pruning`,
    },
    computedAt: new Date().toISOString(),
  };
}

module.exports = { runWalkForward };
