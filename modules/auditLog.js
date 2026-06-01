'use strict';

// ── Live Prediction Audit Log ─────────────────────────────────────────────────
// Every /api/bias call appends: timestamp, symbol, all signal scores, composite.
// Every hour resolveOutcomes() fetches realized next-day returns for predictions
// older than 24h and fills in the outcome field.
//
// Once outcomes accumulate, getSignalIC() computes rolling Spearman IC per signal.
// This is the foundation for empirical calibration of the composite win probability.
//
// Spearman IC chosen over Pearson (Grinold & Kahn 2000, p.56) because:
//   - Return distributions are non-Gaussian (heavy tails)
//   - Rank-based correlation is robust to outlier returns (FOMC, earnings)
//   - IC_IR > 0.5 = marginal signal; > 1.0 = good signal (Grinold & Kahn rule of thumb)
//
// Storage: data/audit_log.ndjson (newline-delimited JSON, O(1) append, 2-year rolling window)

const fs   = require('fs');
const path = require('path');

const LOG_FILE  = path.join(__dirname, '..', 'data', 'audit_log.ndjson');
const MAX_ENTRIES = 504 * 2; // ~2 trading years

// ── File helpers ──────────────────────────────────────────────────────────────
function _readAll() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const text = fs.readFileSync(LOG_FILE, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function _writeAll(entries) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function _append(entry) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

// ── Spearman IC ───────────────────────────────────────────────────────────────
function _rank(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(arr.length);
  // Handle ties by averaging ranks
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
  if (n < 5) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / n;
  const sx  = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) / n);
  const sy  = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0) / n);
  return (sx > 0 && sy > 0) ? cov / (sx * sy) : 0;
}

function spearmanIC(scores, returns) {
  if (scores.length < 5) return 0;
  return _pearsonR(_rank(scores), _rank(returns));
}

// IC_IR: mean(rolling IC) / std(rolling IC) over rolling 20-prediction windows
function icIR(icValues) {
  if (icValues.length < 3) return 0;
  const mean = icValues.reduce((s, v) => s + v, 0) / icValues.length;
  const std  = Math.sqrt(icValues.reduce((s, v) => s + (v - mean) ** 2, 0) / icValues.length);
  return std > 0 ? mean / std : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Called after every /api/bias computation. Extracts signal scores + composite,
// stores them without nextDayReturn (filled in later by resolveOutcomes).
function logPrediction(biasResult) {
  try {
    if (!biasResult || !biasResult.signals) return;

    const signalScores = {};
    for (const [key, sig] of Object.entries(biasResult.signals)) {
      if (typeof sig.score === 'number') signalScores[key] = sig.score;
    }

    const entry = {
      id:        `${biasResult.symbol}_${Date.now()}`,
      ts:        Date.now(),
      symbol:    biasResult.symbol,
      composite: biasResult.composite,
      spot:      biasResult.spot,
      signals:   signalScores,
      regime:    biasResult.regime?.regime ?? null,
      eventRisk: biasResult.eventRisk ?? false,
      nextDayReturn: null,  // filled by resolveOutcomes()
      resolvedAt:    null,
    };

    _append(entry);

    // Rotate log if too large (keep most recent MAX_ENTRIES)
    const all = _readAll();
    if (all.length > MAX_ENTRIES + 50) {
      _writeAll(all.slice(-MAX_ENTRIES));
    }
  } catch (e) {
    console.warn('[auditLog] logPrediction failed:', e.message);
  }
}

// Called hourly. For predictions older than 23h with no outcome, fetch the
// next-day close price and compute realized return.
// `fetchPrice` is injected so this module doesn't depend on dataFetcher directly.
async function resolveOutcomes(fetchPriceHistory) {
  try {
    const all = _readAll();
    const now = Date.now();
    const RESOLVE_AFTER_MS = 23 * 60 * 60 * 1000; // 23h — enough for next daily close

    const pending = all.filter(e => e.nextDayReturn === null && now - e.ts > RESOLVE_AFTER_MS);
    if (!pending.length) return { resolved: 0 };

    // Group by symbol to minimize fetches
    const bySymbol = {};
    for (const e of pending) {
      if (!bySymbol[e.symbol]) bySymbol[e.symbol] = [];
      bySymbol[e.symbol].push(e);
    }

    let resolved = 0;
    for (const [symbol, entries] of Object.entries(bySymbol)) {
      try {
        const bars = await fetchPriceHistory(symbol, '5d', '1d');
        if (!bars || bars.length < 2) continue;

        for (const entry of entries) {
          const predDate = new Date(entry.ts).toISOString().slice(0, 10);
          // Find the bar on or after the prediction date
          const predIdx = bars.findIndex(b => b.date >= predDate);
          if (predIdx < 0 || predIdx >= bars.length - 1) continue;
          const nextBar = bars[predIdx + 1];
          const predBar = bars[predIdx];
          entry.nextDayReturn = (nextBar.close - predBar.close) / predBar.close;
          entry.resolvedAt = new Date().toISOString();
          resolved++;
        }
      } catch (e) {
        console.warn(`[auditLog] resolve failed for ${symbol}:`, e.message);
      }
    }

    if (resolved > 0) _writeAll(all);
    return { resolved };
  } catch (e) {
    console.warn('[auditLog] resolveOutcomes failed:', e.message);
    return { resolved: 0, error: e.message };
  }
}

// Compute rolling Spearman IC per signal from resolved predictions.
// days: rolling window (60, 120, 252). Returns per-signal IC, IC_IR, n.
function getSignalIC(symbol = null, days = 120) {
  try {
    const all = _readAll();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const resolved = all.filter(e =>
      e.nextDayReturn !== null &&
      e.ts >= cutoff &&
      (symbol === null || e.symbol === symbol)
    ).sort((a, b) => a.ts - b.ts);

    if (resolved.length < 10) {
      return { available: false, n: resolved.length, message: 'Need 10+ resolved predictions' };
    }

    // Collect per-signal (score, return) pairs
    const pairs = {}; // signal → [{ score, ret }]
    for (const e of resolved) {
      for (const [sig, score] of Object.entries(e.signals)) {
        if (!pairs[sig]) pairs[sig] = [];
        pairs[sig].push({ score, ret: e.nextDayReturn });
      }
    }

    const signalStats = {};
    for (const [sig, data] of Object.entries(pairs)) {
      if (data.length < 10) continue;
      const scores  = data.map(d => d.score);
      const returns = data.map(d => d.ret);

      const ic = spearmanIC(scores, returns);

      // Rolling 20-prediction IC for IC_IR
      const rollingICs = [];
      const WIN = 20;
      for (let i = WIN; i <= data.length; i += 10) {
        const sliceS = scores.slice(i - WIN, i);
        const sliceR = returns.slice(i - WIN, i);
        rollingICs.push(spearmanIC(sliceS, sliceR));
      }
      const ic_ir = icIR(rollingICs);

      signalStats[sig] = {
        ic:     Math.round(ic * 1000) / 1000,
        ic_ir:  Math.round(ic_ir * 100) / 100,
        n:      data.length,
        grade:  ic_ir >= 1.0 ? 'GOOD' : ic_ir >= 0.5 ? 'MARGINAL' : ic_ir >= 0.3 ? 'WEAK' : 'PRUNE',
      };
    }

    // Composite IC
    const compScores  = resolved.map(e => e.composite);
    const compReturns = resolved.map(e => e.nextDayReturn);
    const compIC      = spearmanIC(compScores, compReturns);

    // Calibration bins: map composite decile to win rate
    const sorted    = [...resolved].sort((a, b) => a.composite - b.composite);
    const binSize   = Math.max(1, Math.floor(sorted.length / 10));
    const bins      = [];
    for (let i = 0; i < sorted.length; i += binSize) {
      const slice = sorted.slice(i, i + binSize);
      const wins  = slice.filter(e => e.nextDayReturn > 0).length;
      const avgRet = slice.reduce((s, e) => s + e.nextDayReturn, 0) / slice.length;
      bins.push({
        range:   [slice[0].composite, slice[slice.length - 1].composite],
        n:       slice.length,
        winRate: Math.round(wins / slice.length * 1000) / 10,
        avgRetBps: Math.round(avgRet * 10000),
      });
    }

    return {
      available: true,
      symbol:    symbol ?? 'ALL',
      window:    `${days}d`,
      n:         resolved.length,
      composite: { ic: Math.round(compIC * 1000) / 1000 },
      signals:   signalStats,
      calibration: { bins, note: 'Win rate per composite decile — empirical, updates with each resolved prediction' },
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// Total log stats for /api/ic status header
function getLogStats() {
  try {
    const all      = _readAll();
    const resolved = all.filter(e => e.nextDayReturn !== null);
    const oldest   = all.length ? new Date(all[0].ts).toISOString().slice(0, 10) : null;
    return { total: all.length, resolved: resolved.length, oldest };
  } catch {
    return { total: 0, resolved: 0, oldest: null };
  }
}

module.exports = { logPrediction, resolveOutcomes, getSignalIC, getLogStats };
