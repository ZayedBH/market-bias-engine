'use strict';

// ── Signal-Accuracy Backtester ────────────────────────────────────────────────
// Walks `lookback` days backward using price-only signals (EMA stack, TSMOM,
// OFI, PDH/PDL). For each day we compute the composite signal on bars up to
// that day, then check whether the next-day return agreed with the signal.
//
// This is an "expanded-window" backtest — each evaluation point uses ALL data
// available up to that day, which is realistic (no look-ahead bias).
//
// Reference: Lo (2002) "The Statistics of Sharpe Ratios"; Grinold & Kahn (2000).

const { tsmomSignal, emaStackScore, pdhPdlScore, computeOFI, vwapZScore } = require('./momentum');
const { computeHurst } = require('./hurst');

// Signal weights — deliberately balanced so any single signal can flip the composite.
// Short-term momentum + OFI are fast-moving and capture corrections;
// EMA is capped to 1-year window to avoid long-term trend swamping corrections.
const WEIGHTS = {
  ema:       0.18,  // medium-term structure (1-yr window)
  tsmom:     0.18,  // 1M/3M trend
  shortMom:  0.22,  // 5d/10d price return — most responsive to current conditions
  ofi:       0.18,  // volume order flow
  pdh:       0.14,  // previous-day structure (ICT)
  vwap:      0.10,  // VWAP z-score
};

function computeSimpleSignal(bars) {
  const closes = bars.map(b => b.close);
  const spot   = closes[closes.length - 1];

  // ── EMA: use bounded 252-bar window so a 1-month correction actually shows ─
  // Without this, a 2-year bull-market EMA never turns negative during a 5% dip.
  const emaCloses = closes.slice(-252);
  const ema       = emaStackScore(emaCloses);

  // ── TSMOM: 1M and 3M lookbacks (skip-1-month convention) ─────────────────
  const tsmom = tsmomSignal(closes.slice(-300), [21, 63]);

  // ── Short-term momentum: avg of 5d and 10d returns ───────────────────────
  // ±1.5% avg over 5–10d → ±10 signal; directly captures corrections/rallies
  const ret5d  = closes.length >  5 ? (spot - closes[closes.length -  6]) / closes[closes.length -  6] : 0;
  const ret10d = closes.length > 10 ? (spot - closes[closes.length - 11]) / closes[closes.length - 11] : 0;
  const avgShortRet   = (ret5d + ret10d) / 2;
  const shortMomScore = Math.max(-10, Math.min(10, avgShortRet / 0.015 * 10));

  // ── OFI: 14-bar proxy on recent 30 bars ──────────────────────────────────
  const ofi  = computeOFI(bars.slice(-30), 14);

  // ── PDH/PDL: previous-day structure ──────────────────────────────────────
  const pdh  = pdhPdlScore(bars.slice(-5));

  // ── VWAP Z-Score: 20-bar rolling ─────────────────────────────────────────
  const vwap = vwapZScore(bars.slice(-25), 20);

  // ── Hurst: H > 0.55 = trending → amplify trend signals slightly ──────────
  const hurstR    = closes.length >= 60 ? computeHurst(closes.slice(-252)) : null;
  const hurstMult = hurstR ? (hurstR.H > 0.55 ? 1.1 : hurstR.H < 0.45 ? 0.9 : 1.0) : 1.0;

  const composite =
    ema.score        * WEIGHTS.ema      * hurstMult +
    tsmom.tsmomScore * WEIGHTS.tsmom    * hurstMult +
    shortMomScore    * WEIGHTS.shortMom +   // NOT amplified by Hurst — raw price signal
    ofi.score        * WEIGHTS.ofi      +
    pdh.score        * WEIGHTS.pdh      +
    vwap.score       * WEIGHTS.vwap;

  return {
    composite: Math.max(-10, Math.min(10, composite)),
    components: {
      ema:       Math.round(ema.score        * 10) / 10,
      tsmom:     Math.round(tsmom.tsmomScore * 10) / 10,
      shortMom:  Math.round(shortMomScore    * 10) / 10,
      ofi:       Math.round(ofi.score        * 10) / 10,
      pdh:       Math.round(pdh.score        * 10) / 10,
      vwap:      Math.round(vwap.score       * 10) / 10,
    },
  };
}

// ── Main backtest function ────────────────────────────────────────────────────
function backtestSignal(bars, lookback = 30) {
  if (bars.length < lookback + 60) {
    return {
      available: false,
      error: `Need at least ${lookback + 60} bars; have ${bars.length}`,
    };
  }

  const results = [];
  const startIdx = bars.length - lookback - 1;

  for (let i = startIdx; i < bars.length - 1; i++) {
    const historicalBars = bars.slice(0, i + 1);
    const sig = computeSimpleSignal(historicalBars);

    // Next-day return
    const today    = bars[i];
    const tomorrow = bars[i + 1];
    const nextRet  = (tomorrow.close - today.close) / today.close;
    const nextRetBps = Math.round(nextRet * 10000);   // in bps

    const signalDir = sig.composite >  0.5 ? 1 : sig.composite < -0.5 ? -1 : 0;
    const actualDir = nextRet > 0.001 ? 1 : nextRet < -0.001 ? -1 : 0;
    const skipped   = signalDir === 0 || actualDir === 0;
    const correct   = !skipped && signalDir === actualDir;

    results.push({
      date:        today.date,
      signalScore: Math.round(sig.composite * 10) / 10,
      signalDir,
      nextRetBps,
      actualDir,
      correct,
      skipped,
      components:  sig.components,
    });
  }

  // ── Accuracy metrics ─────────────────────────────────────────────────────
  const decided  = results.filter(r => !r.skipped);
  const correct  = decided.filter(r => r.correct).length;
  const accuracy = decided.length > 0 ? correct / decided.length : 0;

  // ── Information Coefficient (Pearson r between signal and next-day return) ─
  const n      = results.length;
  const sigs   = results.map(r => r.signalScore);
  const rets   = results.map(r => r.nextRetBps);
  const meanS  = sigs.reduce((a, v) => a + v, 0) / n;
  const meanR  = rets.reduce((a, v) => a + v, 0) / n;
  const cov    = results.reduce((a, r) => a + (r.signalScore - meanS) * (r.nextRetBps - meanR), 0) / n;
  const stdS   = Math.sqrt(results.reduce((a, r) => a + (r.signalScore - meanS) ** 2, 0) / n);
  const stdR   = Math.sqrt(results.reduce((a, r) => a + (r.nextRetBps  - meanR) ** 2, 0) / n);
  const ic     = (stdS > 0 && stdR > 0) ? cov / (stdS * stdR) : 0;

  // ── Return attribution ────────────────────────────────────────────────────
  const bullDays = results.filter(r => r.signalDir >  0);
  const bearDays = results.filter(r => r.signalDir <  0);
  const avgBull  = bullDays.length ? bullDays.reduce((a, r) => a + r.nextRetBps, 0) / bullDays.length : 0;
  const avgBear  = bearDays.length ? bearDays.reduce((a, r) => a + r.nextRetBps, 0) / bearDays.length : 0;

  // ── Profit factor (sum winners / sum losers in decided trades) ────────────
  const winRets  = decided.filter(r => r.correct).map(r => Math.abs(r.nextRetBps));
  const lossRets = decided.filter(r => !r.correct).map(r => Math.abs(r.nextRetBps));
  const sumWin   = winRets.reduce((a, v) => a + v, 0);
  const sumLoss  = lossRets.reduce((a, v) => a + v, 0);
  const profitFactor = sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? Infinity : 1;

  // ── Rolling 10-day accuracy ───────────────────────────────────────────────
  const rollingAcc = [];
  for (let i = 9; i < decided.length; i++) {
    const window = decided.slice(i - 9, i + 1);
    rollingAcc.push({
      date:     window[window.length - 1].date ?? '',
      accuracy: window.filter(r => r.correct).length / window.length,
    });
  }

  return {
    available:      true,
    lookback,
    totalDays:      results.length,
    decidedDays:    decided.length,
    skippedDays:    results.length - decided.length,
    correctDays:    correct,
    accuracy:       Math.round(accuracy * 1000) / 10,    // %
    ic:             Math.round(ic * 1000) / 1000,
    avgBullRetBps:  Math.round(avgBull  * 10) / 10,
    avgBearRetBps:  Math.round(avgBear  * 10) / 10,
    profitFactor:   Math.round(profitFactor * 100) / 100,
    signalWeights:  WEIGHTS,
    rollingAccuracy: rollingAcc,
    results,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { backtestSignal };
