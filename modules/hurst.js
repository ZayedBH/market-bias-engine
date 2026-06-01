'use strict';

// ── Hurst Exponent via R/S Analysis ──────────────────────────────────────────
// Hurst (1951), Peters (1994) Fractal Market Hypothesis
// H < 0.5 → mean-reverting (anti-persistent)
// H = 0.5 → random walk
// H > 0.5 → trending (persistent)

// Lanczos log-gamma — needed for Anis-Lloyd E[R/S] computation
function _logGamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _logGamma(1 - z);
  z -= 1;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Anis-Lloyd (1976) expected R/S for a random walk of length n (H=0.5).
// R/S analysis on short lags over-estimates H without this correction —
// systematic upward bias causes false trending signals (Peters 1994, p.62).
function _anisLloydExpected(n) {
  if (n < 2) return 1;
  let sum = 0;
  for (let i = 1; i < n; i++) sum += Math.sqrt((n - i) / i);
  // Γ((n-1)/2) / (√π × Γ(n/2))
  const logRatio = _logGamma((n - 1) / 2) - 0.5 * Math.log(Math.PI) - _logGamma(n / 2);
  return Math.exp(logRatio) * sum * (n - 0.5) / n;
}

function hurstRS(returns, lags = [5, 10, 20, 40, 80]) {
  const rsValues = [];

  for (const lag of lags) {
    const chunks = [];
    for (let i = 0; i + lag <= returns.length; i += lag) {
      chunks.push(returns.slice(i, i + lag));
    }
    if (chunks.length < 2) continue;

    const rsChunk = chunks.map(chunk => {
      const n    = chunk.length;
      const mean = chunk.reduce((s, v) => s + v, 0) / n;
      const devs = chunk.map(v => v - mean);
      const cumdev = devs.map((_, i) => devs.slice(0, i + 1).reduce((s, v) => s + v, 0));
      const R    = Math.max(...cumdev) - Math.min(...cumdev);
      const S    = Math.sqrt(chunk.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
      return S > 0 ? R / S : 0;
    }).filter(v => v > 0);

    if (rsChunk.length > 0) {
      const avgRS = rsChunk.reduce((s, v) => s + v, 0) / rsChunk.length;
      // Anis-Lloyd bias correction: subtract expected log(R/S) under H=0.5, restore 0.5*log(n)
      // so OLS still regresses corrected log(R/S) vs log(n) but without small-sample bias.
      const eRS = _anisLloydExpected(lag);
      const yCorrected = Math.log(avgRS) - Math.log(eRS) + 0.5 * Math.log(lag);
      rsValues.push([Math.log(lag), yCorrected]);
    }
  }

  if (rsValues.length < 3) return 0.5;

  // OLS: log(R/S) = H * log(N) + C
  const n = rsValues.length;
  const sumX  = rsValues.reduce((s, [x]) => s + x, 0);
  const sumY  = rsValues.reduce((s, [, y]) => s + y, 0);
  const sumXY = rsValues.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = rsValues.reduce((s, [x]) => s + x * x, 0);
  const H = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ** 2);

  return Math.max(0, Math.min(1, H));
}

function rollingHurst(prices, window = 20) {
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  if (returns.length < window) return 0.5;
  const slice = returns.slice(-window);
  return hurstRS(slice, [5, 10, Math.floor(window / 2), window]);
}

function computeHurst(prices) {
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  if (returns.length < 20) {
    return { H: 0.5, H5d: 0.5, H20d: 0.5, H60d: 0.5, regime: 'RANDOM', score: 0 };
  }

  const H    = hurstRS(returns);
  const H5d  = rollingHurst(prices.slice(-10), 5);
  const H20d = rollingHurst(prices.slice(-45), 20);
  const H60d = rollingHurst(prices.slice(-85), 60);

  const regime = H > 0.6 ? 'TRENDING' : H < 0.4 ? 'MEAN_REVERTING' : 'RANDOM';

  // Momentum validity: how much to trust trend-following signals
  const momentumValidity = Math.max(0, (H - 0.5) * 4);      // 0 at H=0.5, 1 at H=0.75
  const reversionValidity = Math.max(0, (0.5 - H) * 4);    // 0 at H=0.5, 1 at H=0.25

  // Bias adjustment score: -10 to +10
  // Trending H → amplify trend signal; mean-reverting H → fade trend signal
  const score = Math.max(-5, Math.min(5, (H - 0.5) * 20));

  return { H, H5d, H20d, H60d, regime, momentumValidity, reversionValidity, score };
}

// ── Ornstein-Uhlenbeck Process ────────────────────────────────────────────────
// Avellaneda & Lee (2009): Statistical Arbitrage in US Equities
// dX_t = κ(μ - X_t)dt + σ dW_t
// Mean-reversion speed κ, equilibrium μ, noise σ

function fitOU(series) {
  if (series.length < 10) {
    return { kappa: 0, mu: 0, sigma: 0, halfLife: Infinity, zScore: 0, signal: 0, magnitude: 0, isMeanReverting: false };
  }

  const x  = series;
  const dx = x.slice(1).map((v, i) => v - x[i]);
  const xLag = x.slice(0, -1);

  // OLS: dx = a + b*x_lag + ε  (discrete OU)
  const n    = xLag.length;
  const sumX  = xLag.reduce((s, v) => s + v, 0);
  const sumDx = dx.reduce((s, v) => s + v, 0);
  const sumXDx = xLag.reduce((s, v, i) => s + v * dx[i], 0);
  const sumX2  = xLag.reduce((s, v) => s + v * v, 0);

  const denom = n * sumX2 - sumX ** 2;
  if (Math.abs(denom) < 1e-12) {
    return { kappa: 0, mu: 0, sigma: 0, halfLife: Infinity, zScore: 0, signal: 0, magnitude: 0, isMeanReverting: false };
  }

  const b = (n * sumXDx - sumX * sumDx) / denom;
  const a = (sumDx - b * sumX) / n;

  const kappa = -b; // mean-reversion speed
  const mu    = kappa > 0 ? a / kappa : (sumX / n); // equilibrium level

  // Residuals → sigma
  const residuals = dx.map((d, i) => d - (a + b * xLag[i]));
  const sigma = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / n);

  const halfLife  = kappa > 0 ? Math.log(2) / kappa : Infinity;
  // Equilibrium std deviation: sigma_eq = sigma / sqrt(2κ)
  const sigmaEq   = kappa > 0 ? sigma / Math.sqrt(2 * kappa) : sigma;
  const currentVal = x[x.length - 1];
  const zScore    = sigmaEq > 0 ? (currentVal - mu) / sigmaEq : 0;

  // Avellaneda s-score threshold: |z| > 1.5 → trade
  let signal = 0, magnitude = 0;
  if (zScore > 1.5) {
    signal    = -1; // above equilibrium → expect reversion down → BEARISH
    magnitude = Math.min((zScore - 1.5) / 1.5, 1.0);
  } else if (zScore < -1.5) {
    signal    = 1;  // below equilibrium → expect reversion up → BULLISH
    magnitude = Math.min((-zScore - 1.5) / 1.5, 1.0);
  }

  return {
    kappa,
    mu,
    sigma,
    sigmaEq,
    halfLife,
    zScore,
    signal,
    magnitude,
    isMeanReverting: kappa > 0 && halfLife < 30,
    score: signal * magnitude * 10,
  };
}

// Convenience: score a named spread/series for bias engine
function ouScore(name, series) {
  const result = fitOU(series);
  return { name, ...result };
}

module.exports = { hurstRS, rollingHurst, computeHurst, fitOU, ouScore };
