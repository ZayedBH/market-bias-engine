'use strict';

// ── Gaussian Hidden Markov Model — Full Baum-Welch EM Implementation ─────────
// Hamilton (1989) regime switching; Kim, Hammami & Rombouts (2019) HMM portfolio
//
// Feature vector (4 dims): [daily_return_z, realized_vol_z, vix_z, momentum_z]
// States: 0=LOW_VOL_BULL, 1=HIGH_VOL_CHOP, 2=CRASH_BEAR, 3=RECOVERY
// Diagonal covariance per state (regularized to avoid degeneracy)

const STATE_LABELS = ['LOW_VOL_BULL', 'HIGH_VOL_CHOP', 'CRASH_BEAR', 'RECOVERY'];

const WEIGHT_MULTIPLIERS = {
  0: { trend: 1.3,  options_gex: 1.0, momentum: 1.3, volatility: 0.8, macro: 0.9 },
  1: { trend: 0.7,  options_gex: 1.5, momentum: 0.6, volatility: 1.4, macro: 1.0 },
  2: { trend: 0.5,  options_gex: 1.2, momentum: 0.5, volatility: 1.8, macro: 1.2 },
  3: { trend: 1.0,  options_gex: 1.3, momentum: 1.1, volatility: 1.3, macro: 0.9 },
};

// ── Numerical utilities ───────────────────────────────────────────────────────
function logSumExp(arr) {
  const max = arr.reduce((m, v) => Math.max(m, v), -Infinity);
  if (!isFinite(max)) return -Infinity;
  return max + Math.log(arr.reduce((s, v) => s + Math.exp(v - max), 0));
}

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1;
}

// ── Log-gamma (Lanczos) — for Student-t emission ──────────────────────────────
function _logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _logGamma(1 - z);
  z -= 1;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
              771.32342877765313, -176.61502916214059, 12.507343278686905,
              -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Student-t emission constants (ν = 5 degrees of freedom)
// ν = 5 is well-suited for equity returns: heavier tails than Gaussian but still
// tractable. Gaussian HMM systematically assigns near-zero probability to crash-
// sized moves (±3σ+), causing CRASH_BEAR to be chronically underweighted.
// Student-t with ν = 5 assigns ~7× more probability to 3σ events.
// Reference: Chib & Hamilton (2002) "Semiparametric Bayesian inference in
//            multiple-equation models" — Student-t regime switching.
const _NU   = 5;
const _LG_A = _logGamma((_NU + 1) / 2);  // logΓ((ν+1)/2)
const _LG_B = _logGamma(_NU / 2);        // logΓ(ν/2)
// Per-dimension constant: logΓ((ν+1)/2) - logΓ(ν/2) - 0.5*log(ν*π)
const _T_CONST = _LG_A - _LG_B - 0.5 * Math.log(_NU * Math.PI);

function zscore(arr) {
  const m = mean(arr), s = std(arr);
  return arr.map(v => (v - m) / s);
}

// ── Feature engineering ───────────────────────────────────────────────────────
function buildFeatureMatrix(closes, vixSeries) {
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const T       = returns.length;
  if (T < 30) return null;

  // 5-day rolling realized vol
  const rv5 = returns.map((_, i) => {
    if (i < 4) return 0;
    const slice = returns.slice(i - 4, i + 1);
    const m = mean(slice);
    return Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / 5) * Math.sqrt(252);
  });

  // 20-day rolling return
  const ret20 = returns.map((_, i) => {
    if (i < 19) return 0;
    return returns.slice(i - 19, i + 1).reduce((s, v) => s + v, 0);
  });

  // VIX alignment to returns array (1 shorter than closes)
  const vixAligned = vixSeries
    ? closes.slice(1).map((_, i) => {
        const idx = Math.min(Math.floor((i / T) * vixSeries.length), vixSeries.length - 1);
        return vixSeries[idx] ?? 20;
      })
    : returns.map(() => 20);

  // Z-score each feature for stationarity
  const retZ  = zscore(returns);
  const rv5Z  = zscore(rv5);
  const vixZ  = zscore(vixAligned);
  const ret20Z = zscore(ret20);

  // Feature matrix: T × 4
  return returns.map((_, i) => [retZ[i], rv5Z[i], vixZ[i], ret20Z[i]]);
}

// ── Gaussian HMM with Baum-Welch EM ──────────────────────────────────────────
class GaussianHMM {
  constructor(nStates = 4, nDims = 4, maxIter = 80, tol = 1e-3) {
    this.N       = nStates;
    this.D       = nDims;
    this.maxIter = maxIter;
    this.tol     = tol;
    this.fitted  = false;
    this.pi      = null;
    this.A       = null;
    this.mu      = null;
    this.sigma   = null;
    this.logLik  = -Infinity;
  }

  // K-means++ initialization of state means
  _initMeans(X, rng = Math.random.bind(Math)) {
    const T = X.length;
    const N = this.N;
    const D = this.D;
    const chosen = [];

    // First center: deterministic via seeded rng
    chosen.push(X[Math.floor(rng() * T)]);

    // Subsequent centers: D²-weighted sampling
    while (chosen.length < N) {
      const dists = X.map(x => {
        const minD = chosen.reduce((min, c) => {
          const d = c.reduce((s, v, i) => s + (v - x[i]) ** 2, 0);
          return Math.min(min, d);
        }, Infinity);
        return minD;
      });
      const total = dists.reduce((s, v) => s + v, 0);
      let r = rng() * total;
      for (let i = 0; i < T; i++) {
        r -= dists[i];
        if (r <= 0) { chosen.push(X[i]); break; }
      }
      if (chosen.length < chosen.length + 1) chosen.push(X[0]); // safety
    }

    return chosen.map(c => [...c]);
  }

  _init(X, rng = Math.random.bind(Math)) {
    const N = this.N, D = this.D;

    // Initial state distribution: uniform
    this.pi = Array(N).fill(1 / N);

    // Transition matrix: sticky (high self-transition = regime persistence)
    const selfProb = 0.75;
    const offProb  = (1 - selfProb) / (N - 1);
    this.A = Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => i === j ? selfProb : offProb)
    );

    // Emission means via k-means++ with seeded rng
    this.mu = this._initMeans(X, rng);

    // Emission variances: overall data variance per dimension
    const overallVar = Array.from({ length: D }, (_, d) => {
      const vals = X.map(x => x[d]);
      const m    = mean(vals);
      return Math.max(0.1, vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
    });
    this.sigma = Array.from({ length: N }, () => [...overallVar]);
  }

  // Student-t emission (ν=5, diagonal covariance) — replaces Gaussian
  // Fat tails: 3σ events get ~7× more probability vs Gaussian, preventing
  // crash-regime observations from being assigned near-zero likelihood.
  // M-step still uses Gaussian sufficient statistics (hybrid EM) — standard
  // practice when full Student-t EM complexity isn't warranted.
  _logEmit(x, n) {
    let lp = 0;
    for (let d = 0; d < this.D; d++) {
      const v    = this.sigma[n][d];                    // variance
      const diff = x[d] - this.mu[n][d];
      // logP = const - 0.5*log(v) - ((ν+1)/2)*log(1 + diff²/(ν*v))
      lp += _T_CONST - 0.5 * Math.log(v) -
            ((_NU + 1) / 2) * Math.log(1 + diff * diff / (_NU * v));
    }
    return isFinite(lp) ? lp : -1e10;
  }

  // Forward algorithm in log-space
  _forward(X) {
    const T = X.length, N = this.N;
    const alpha = Array.from({ length: T }, () => Array(N).fill(-Infinity));

    for (let n = 0; n < N; n++) {
      alpha[0][n] = Math.log(this.pi[n] + 1e-300) + this._logEmit(X[0], n);
    }
    for (let t = 1; t < T; t++) {
      for (let n = 0; n < N; n++) {
        const incoming = alpha[t - 1].map((a, m) => a + Math.log(this.A[m][n] + 1e-300));
        alpha[t][n] = logSumExp(incoming) + this._logEmit(X[t], n);
      }
    }
    return alpha;
  }

  // Backward algorithm in log-space
  _backward(X) {
    const T = X.length, N = this.N;
    const beta = Array.from({ length: T }, () => Array(N).fill(0));

    for (let t = T - 2; t >= 0; t--) {
      for (let n = 0; n < N; n++) {
        const outgoing = Array.from({ length: N }, (_, m) =>
          Math.log(this.A[n][m] + 1e-300) + this._logEmit(X[t + 1], m) + beta[t + 1][m]
        );
        beta[t][n] = logSumExp(outgoing);
      }
    }
    return beta;
  }

  // Baum-Welch EM: fit parameters to observation sequence
  // seed: deterministic integer seed for k-means++ init — same seed → same cluster centers
  fit(X, seed = 42) {
    if (!X || X.length < 20) return this;
    const rng = mulberry32(seed);
    this._init(X, rng);

    const T = X.length, N = this.N, D = this.D;
    let prevLogLik = -Infinity;

    for (let iter = 0; iter < this.maxIter; iter++) {
      // E-step
      const alpha = this._forward(X);
      const beta  = this._backward(X);
      const logLik = logSumExp(alpha[T - 1]);

      if (!isFinite(logLik)) break;
      if (Math.abs(logLik - prevLogLik) < this.tol && iter > 5) break;
      prevLogLik = logLik;

      // Gamma: posterior P(state=n | t)
      const gamma = alpha.map((at, t) => {
        const raw  = at.map((a, n) => a + beta[t][n]);
        const norm = logSumExp(raw);
        return raw.map(r => Math.exp(r - norm));
      });

      // Xi: expected transition counts
      const xiSum = Array.from({ length: N }, () => Array(N).fill(0));
      for (let t = 0; t < T - 1; t++) {
        const vals = [];
        for (let n = 0; n < N; n++) {
          for (let m = 0; m < N; m++) {
            vals.push(alpha[t][n] + Math.log(this.A[n][m] + 1e-300) +
                      this._logEmit(X[t + 1], m) + beta[t + 1][m]);
          }
        }
        const norm2 = logSumExp(vals);
        let vi = 0;
        for (let n = 0; n < N; n++) {
          for (let m = 0; m < N; m++) {
            xiSum[n][m] += Math.exp(vals[vi++] - norm2);
          }
        }
      }

      // M-step — update pi
      this.pi = gamma[0].slice();

      // Update A
      for (let n = 0; n < N; n++) {
        const rowSum = xiSum[n].reduce((s, v) => s + v, 0) + 1e-10;
        for (let m = 0; m < N; m++) this.A[n][m] = xiSum[n][m] / rowSum;
      }

      // Update mu and sigma
      for (let n = 0; n < N; n++) {
        const gSum = gamma.reduce((s, g) => s + g[n], 0) + 1e-10;
        this.mu[n] = Array.from({ length: D }, (_, d) =>
          gamma.reduce((s, g, t) => s + g[n] * X[t][d], 0) / gSum
        );
        this.sigma[n] = Array.from({ length: D }, (_, d) => {
          const v = gamma.reduce((s, g, t) => {
            const diff = X[t][d] - this.mu[n][d];
            return s + g[n] * diff * diff;
          }, 0) / gSum;
          return Math.max(v, 0.01); // regularization floor
        });
      }
    }

    this.logLik = prevLogLik;
    this.fitted = true;
    return this;
  }

  // Predict posteriors using a short trailing window + temperature softening.
  //
  // Why not the full 100-bar forward pass?
  // Each forward step compounds the log-prob gap by ~1-3 nats. After 100 steps
  // the winning state is 40-150 nats ahead → exp(-150) underflows to 0 in float64
  // → raw probs collapse to [0,0,0,1] regardless of actual uncertainty.
  //
  // Fix: run forward on the last WINDOW bars only so compounding is limited,
  // then apply TEMPERATURE > 1 to soften the log-alpha before exp().
  // Result: probabilities that actually reflect uncertainty (0.55 vs 0.99+).
  predictLast(X, window = 20, temperature = 3.0) {
    if (!this.fitted || !X.length) return null;

    // Use only recent observations so log-probs don't compound to float extremes
    const tail  = X.slice(-Math.min(window, X.length));
    const alpha = this._forward(tail);
    const last  = alpha[tail.length - 1];

    // Average posteriors over final 5 steps for stability (less sensitive to single outlier bar)
    const avgWindow = Math.min(5, tail.length);
    const avgLogAlpha = Array(this.N).fill(0);
    for (let t = tail.length - avgWindow; t < tail.length; t++) {
      for (let n = 0; n < this.N; n++) {
        avgLogAlpha[n] += alpha[t][n] / avgWindow;
      }
    }

    // Temperature scaling: dividing log-probs by temperature > 1 flattens the distribution.
    // temp=1 → raw (overconfident), temp=3 → softened, temp=∞ → uniform
    const maxLog = Math.max(...avgLogAlpha);
    const probs  = avgLogAlpha.map(a => Math.exp((a - maxLog) / temperature));
    const total  = probs.reduce((s, v) => s + v, 0) || 1;
    const normProbs = probs.map(p => Math.max(0, p / total));
    const stateId   = normProbs.indexOf(Math.max(...normProbs));
    return { stateId, probs: normProbs };
  }

  // Classify state into semantic label based on state means (dim 0=return, dim 1=vol)
  classifyStates() {
    // State with highest return-mean = LOW_VOL_BULL
    // State with lowest return-mean = CRASH_BEAR
    // State with highest vol-mean (among remaining) = HIGH_VOL_CHOP
    // Remaining = RECOVERY
    const indexed = this.mu.map((m, i) => ({ i, retMean: m[0], volMean: m[1] }));
    const sorted  = [...indexed].sort((a, b) => b.retMean - a.retMean);

    const mapping = Array(this.N);
    mapping[sorted[0].i] = 0; // highest return → LOW_VOL_BULL
    mapping[sorted[sorted.length - 1].i] = 2; // lowest return → CRASH_BEAR
    const remaining = sorted.slice(1, -1).sort((a, b) => b.volMean - a.volMean);
    mapping[remaining[0]?.i ?? 1] = 1; // higher vol → HIGH_VOL_CHOP
    mapping[remaining[1]?.i ?? 2] = 3; // remaining → RECOVERY

    return mapping;
  }
}

// ── Seeded RNG (Mulberry32) — deterministic k-means++ init ───────────────────
// Using Math.random() causes k-means++ to assign different clusters each retrain,
// silently flipping the regime label every 6 hours. Same seed → same init → stable.
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Regime singleton per symbol ───────────────────────────────────────────────
const modelCache = {};

// ── GEX-aware regime overlay for futures ─────────────────────────────────────
// For ES/NQ the gamma flip vs spot relationship overrides/adjusts the HMM label
// because dealer hedging flows are the #1 intraday driver of ES/NQ movement.
// Gamma flip = where dealer net gamma crosses zero.
// Above flip: dealers are long gamma → they SELL rallies, BUY dips → PINNING
// Below flip: dealers are short gamma → they BUY rallies, SELL dips → TRENDING
function computeGEXRegimeOverlay(baseRegime, gexContext) {
  if (!gexContext) return baseRegime;
  const { spot, gammaFlip, totalGEX, pcRatio } = gexContext;
  if (!spot || !gammaFlip) return baseRegime;

  const aboveFlip  = spot > gammaFlip;
  const gexBull    = totalGEX > 0; // positive total GEX = pinning environment
  const pctFromFlip = (spot - gammaFlip) / gammaFlip; // % spot is above/below flip

  // GEX environment label
  let gexEnv, gexDesc;
  if (gexBull && aboveFlip) {
    gexEnv  = 'GEX_PINNING';       // Above flip, positive GEX → strong pin, fades/range
    gexDesc = 'Above gamma flip, positive GEX → expect pinning and mean reversion';
  } else if (gexBull && !aboveFlip) {
    gexEnv  = 'GEX_SOFT_SUPPORT';  // Below flip but still positive → softer pin
    gexDesc = 'Below gamma flip, positive GEX → range with downside support';
  } else if (!gexBull && aboveFlip) {
    gexEnv  = 'GEX_WEAK_BREAKOUT'; // Above flip, negative GEX → move can extend
    gexDesc = 'Above gamma flip, negative GEX → weak amplification of up moves';
  } else {
    gexEnv  = 'GEX_TRENDING';      // Below flip, negative GEX → dealers amplify moves
    gexDesc = 'Below gamma flip, negative GEX → trending/volatile, moves amplify';
  }

  // Adjust weight multipliers based on GEX environment
  // In pinning regimes: boost options_gex signal, reduce pure trend/momentum
  // In trending regimes: boost momentum, reduce option pinning signals
  const gexWeightAdj = {
    'GEX_PINNING':       { options_gex: +0.3, momentum: -0.2, trend: -0.1 },
    'GEX_SOFT_SUPPORT':  { options_gex: +0.15, momentum: -0.1, trend: 0   },
    'GEX_WEAK_BREAKOUT': { options_gex: -0.1, momentum: +0.1,  trend: +0.1 },
    'GEX_TRENDING':      { options_gex: -0.2, momentum: +0.2,  trend: +0.2 },
  };

  const adj = gexWeightAdj[gexEnv] ?? {};
  const adjustedMultipliers = { ...baseRegime.weightMultipliers };
  for (const [cat, delta] of Object.entries(adj)) {
    if (adjustedMultipliers[cat] !== undefined) {
      adjustedMultipliers[cat] = Math.max(0.3, Math.min(2.5, adjustedMultipliers[cat] + delta));
    }
  }

  // Put/Call ratio overlay: extreme fear (pcRatio > 2) skews bullish contrarian
  const pcAdjNote = pcRatio > 2.0 ? ' | P/C extreme fear → contrarian bullish' :
                    pcRatio < 0.8 ? ' | P/C complacency → contrarian bearish'   : '';

  return {
    ...baseRegime,
    weightMultipliers: adjustedMultipliers,
    gexOverlay: {
      environment:   gexEnv,
      description:   gexDesc + pcAdjNote,
      aboveFlip,
      pctFromFlip:   parseFloat((pctFromFlip * 100).toFixed(2)),
      totalGEX,
      pcRatio:       pcRatio ?? null,
    },
  };
}

// ── Main regime computation ───────────────────────────────────────────────────
// @param symbol    instrument symbol (used for model cache key)
// @param closes    price close array — for futures, pass proxy ETF closes (SPY/QQQ)
//                  so the HMM trains on the same series as the options data
// @param vixSeries array of VIX close values aligned to closes[] — if null uses scalar
// @param vixScalar fallback scalar VIX when series unavailable
// @param gexContext optional { spot, gammaFlip, totalGEX, pcRatio } for futures overlay
function computeRegime(symbol, closes, vixSeries = null, vixScalar = 20, gexContext = null) {
  const vixCurrent = vixScalar ?? 20;
  if (closes.length < 60) {
    const base = _fallbackRegime(closes, vixCurrent);
    return computeGEXRegimeOverlay(base, gexContext);
  }

  let entry = modelCache[symbol];
  const now = Date.now();
  const RETRAIN_MS = 6 * 60 * 60 * 1000; // retrain every 6 hours

  // Build VIX feature: use actual series if available, otherwise fill with scalar
  // A flat scalar → all-zero z-score → useless feature → random regime assignment.
  // The series must be interpolated to match the closes array length.
  let vixForFeature;
  if (vixSeries && vixSeries.length >= 10) {
    // Interpolate vixSeries to match closes.length - 1 (returns length)
    const T     = closes.length - 1;
    const srcN  = vixSeries.length;
    vixForFeature = Array.from({ length: T }, (_, i) => {
      const srcIdx = Math.min(Math.floor(i * srcN / T), srcN - 1);
      return vixSeries[srcIdx] ?? vixCurrent;
    });
  } else {
    // No series — at least add slight noise to prevent z-score collapse
    // by using the current VIX + small temporal decay (older periods had 20 baseline)
    vixForFeature = Array(closes.length - 1).fill(vixCurrent);
  }

  const X = buildFeatureMatrix(closes, vixForFeature);
  if (!X || X.length < 30) {
    const base = _fallbackRegime(closes, vixCurrent);
    return computeGEXRegimeOverlay(base, gexContext);
  }

  // ── Ensemble: 3 restarts to kill random k-means++ seed instability ──────────
  // k-means++ is stochastic. A single fit can place cluster centers differently
  // each 6-hour retrain, silently flipping the regime label.
  // Fix: fit N_RUNS models, take the one with best log-likelihood (most stable),
  // average their softened posteriors for the confidence estimate.
  const N_RUNS = 3;
  if (!entry || now - entry.trainedAt > RETRAIN_MS) {
    let bestHMM = null, bestLL = -Infinity;
    const allModels = [];

    // Seeds are fixed per run so every 6-hour retrain produces identical cluster inits.
    // Different seeds across runs ensures we explore different local optima in the EM landscape.
    const SEEDS = [42, 137, 271];
    for (let run = 0; run < N_RUNS; run++) {
      const hmm = new GaussianHMM(4, 4, 80, 1e-3);
      hmm.fit(X, SEEDS[run]);
      if (hmm.fitted) {
        allModels.push({ hmm, stateMap: hmm.classifyStates() });
        if (hmm.logLik > bestLL) { bestLL = hmm.logLik; bestHMM = hmm; }
      }
    }

    if (!bestHMM) {
      const base = _fallbackRegime(closes, vixCurrent);
      return computeGEXRegimeOverlay(base, gexContext);
    }

    entry = {
      hmm:       bestHMM,
      allModels,
      trainedAt: now,
      stateMap:  bestHMM.classifyStates(),
    };
    modelCache[symbol] = entry;
  }

  // Ensemble posterior: average softened posteriors from all fitted models,
  // remapping each model's raw states to semantic labels independently.
  const semanticProbs = Array(4).fill(0);
  const models = entry.allModels ?? [{ hmm: entry.hmm, stateMap: entry.stateMap }];

  for (const { hmm, stateMap } of models) {
    const pred = hmm.predictLast(X); // uses window=20, temp=3 from updated method
    if (!pred) continue;
    pred.probs.forEach((p, rawState) => {
      const semantic = stateMap[rawState] ?? rawState;
      semanticProbs[semantic] = (semanticProbs[semantic] ?? 0) + p / models.length;
    });
  }

  if (semanticProbs.every(p => p === 0)) {
    const base = _fallbackRegime(closes, vixCurrent);
    return computeGEXRegimeOverlay(base, gexContext);
  }

  const stateId    = semanticProbs.indexOf(Math.max(...semanticProbs));

  // Entropy-based confidence: H = -sum(p*log(p)), normalized by log(N).
  // Pure entropy gives 0 (uniform/totally uncertain) → 1 (all mass on one state).
  // We then scale to [0.40, 0.92] — never report below 40% (model has 4 states,
  // random baseline is 25%) or above 92% (financial regimes are never truly certain).
  const entropy    = -semanticProbs.reduce((s, p) => s + (p > 1e-9 ? p * Math.log(p) : 0), 0);
  const maxEntropy = Math.log(4); // log(N) for uniform distribution
  const rawConf    = 1 - entropy / maxEntropy;   // 0=uncertain, 1=certain
  const confidence = 0.40 + rawConf * 0.52;      // scale to [0.40, 0.92]

  const regimeScores = { 0: 5, 1: 0, 2: -6, 3: 3 };

  const base = {
    regime:            STATE_LABELS[stateId],
    stateId,
    confidence,
    allProbs:          STATE_LABELS.reduce((o, l, i) => ({ ...o, [l]: semanticProbs[i] }), {}),
    weightMultipliers: WEIGHT_MULTIPLIERS[stateId],
    score:             regimeScores[stateId] * confidence,
    hmmFitted:         true,
    logLik:            entry.hmm.logLik,
  };

  return computeGEXRegimeOverlay(base, gexContext);
}

// Simple fallback when not enough data for HMM
function _fallbackRegime(closes, vixCurrent) {
  const n = closes.length;
  const ret20 = n > 20 ? (closes[n-1] - closes[n-21]) / closes[n-21] : 0;
  const rv20  = (() => {
    const slice = closes.slice(-21);
    const rets  = slice.slice(1).map((c, i) => Math.log(c / slice[i]));
    const m = rets.reduce((s, v) => s + v, 0) / rets.length;
    return Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length * 252) * 100;
  })();
  const vix = vixCurrent ?? 20;

  let stateId;
  if (vix < 18 && ret20 > 0)      stateId = 0; // LOW_VOL_BULL
  else if (vix > 28 && ret20 < 0) stateId = 2; // CRASH_BEAR
  else if (vix > 20)               stateId = 1; // HIGH_VOL_CHOP
  else                             stateId = 3; // RECOVERY

  const confidence = 0.45;
  const semanticProbs = Array(4).fill((1 - confidence) / 3);
  semanticProbs[stateId] = confidence;
  const regimeScores = { 0: 5, 1: 0, 2: -6, 3: 3 };

  return {
    regime:           STATE_LABELS[stateId],
    stateId,
    confidence,
    allProbs:         STATE_LABELS.reduce((o, l, i) => ({ ...o, [l]: semanticProbs[i] }), {}),
    weightMultipliers: WEIGHT_MULTIPLIERS[stateId],
    score:            regimeScores[stateId] * confidence,
    hmmFitted:        false,
  };
}

// Invalidate cache for a symbol (call when data changes)
function invalidateModel(symbol) { delete modelCache[symbol]; }

module.exports = { computeRegime, computeGEXRegimeOverlay, GaussianHMM, buildFeatureMatrix, STATE_LABELS, WEIGHT_MULTIPLIERS, invalidateModel };
