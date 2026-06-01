'use strict';

// ── Kelly Criterion Position Sizing ──────────────────────────────────────────
// Kelly (1956), MacLean, Ziemba & Blazenko (1992): Half-Kelly optimal for typical investors
// Bias-confidence-adjusted sizing using regime-aware vol scaling

function continuousKelly(mu, sigma) {
  // Merton's continuous-time Kelly: f* = μ / σ²
  if (sigma <= 0) return 0;
  return mu / sigma ** 2;
}

function biasAdjustedKelly(biasScore, confidence, vix, kellyFraction = 0.5) {
  // biasScore: -100 to +100
  // confidence: 0 to 1 (signal agreement — NOT out-of-sample win rate)
  // vix: VIX index value (e.g. 18.4)

  const absScore = Math.abs(biasScore);

  // ⚠ UNVALIDATED: this mapping has no empirical calibration.
  // Until 500+ out-of-sample (score → next-day return) observations exist,
  // this win probability is an invented monotonic function, not a measured one.
  // Isotonic regression or Platt scaling on historical (score, outcome) pairs
  // is required before this output should drive real position sizing.
  // For now kellyFraction is halved by the event-risk reducer in bias.js,
  // and the hard 5% cap provides a last-resort circuit breaker.
  const rawWinProb  = 0.5 + (absScore / 100) * 0.15;
  // Blend with 50/50 based on signal agreement (confidence)
  const winProb     = rawWinProb * confidence + 0.5 * (1 - confidence);

  // Assumed reward/risk ratio (configurable)
  const b = 1.5; // 1.5:1 R:R
  const p = winProb;
  const q = 1 - p;

  // Kelly formula: f* = (b*p - q) / b
  const fullKelly = Math.max(0, (b * p - q) / b);
  const halfKelly = fullKelly * kellyFraction;

  // Volatility scalar: reduce size when VIX is elevated
  // At VIX = 15: scalar = 1.0; at VIX = 30: scalar = 0.4; at VIX = 40: scalar = 0.2
  const iv = vix ? vix / 100 : 0.18;
  const volScalar = Math.max(0.2, 1 - (iv - 0.15) * 2);
  const adjustedSize = halfKelly * volScalar;

  // Hard cap: 5% max risk per trade (institutional standard)
  const finalSize = Math.min(adjustedSize, 0.05);

  return {
    winProbability: winProb,
    fullKelly,
    halfKelly,
    volScalar,
    recommendedSize: finalSize,
    riskPct: `${(finalSize * 100).toFixed(1)}%`,
    rationale: `[UNVALIDATED] Win P=${(winProb * 100).toFixed(0)}% × sig-agree=${(confidence * 100).toFixed(0)}% × volScalar=${volScalar.toFixed(2)} → ${(finalSize * 100).toFixed(1)}% risk`,
    calibrated: false,
    direction: biasScore >= 0 ? 'LONG' : 'SHORT',
  };
}

// ── Bootstrap Signal Agreement Interval ──────────────────────────────────────
// Measures INTERNAL COHERENCE: how sensitive the composite is to signal dropout.
// Uses normalizedWeight (post-regime-multiplier) so regime adjustments are reflected.
// This is NOT a predictive confidence interval — it does not measure out-of-sample accuracy.
// A tight interval means signals agree with each other; it says nothing about whether
// the market will move in the indicated direction.
function bootstrapCI(signals, iterations = 1000) {
  const entries  = Object.entries(signals);
  const n        = entries.length;
  const subsetN  = Math.max(3, Math.floor(n * 0.7));
  const scores   = [];

  for (let i = 0; i < iterations; i++) {
    // Random subset without replacement
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const subset   = shuffled.slice(0, subsetN);

    // Use normalizedWeight (includes regime multipliers + cluster budgets) so the
    // bootstrap reflects the same weighting scheme as the actual composite.
    // Falls back to raw weight when normalizedWeight is not yet computed.
    const totalW = subset.reduce((s, [, sig]) => s + (sig.normalizedWeight ?? sig.weight), 0);
    if (totalW === 0) continue;

    const subScore = subset.reduce((s, [, sig]) => s + sig.score * (sig.normalizedWeight ?? sig.weight) / totalW, 0);
    // Same atan soft-scale as the main composite so CI bounds are on the same axis
    scores.push(Math.round((2 / Math.PI) * Math.atan(subScore / 5) * 100));
  }

  if (!scores.length) return { ciLow: -50, ciHigh: 50, confidence: 0.5 };

  scores.sort((a, b) => a - b);
  const ciLow  = scores[Math.floor(0.05 * scores.length)];
  const ciHigh = scores[Math.floor(0.95 * scores.length)];

  // Tighter CI = higher signal agreement (not predictive accuracy)
  const confidence = Math.max(0.1, Math.min(0.99, 1 - (ciHigh - ciLow) / 200));

  return { ciLow: Math.round(ciLow), ciHigh: Math.round(ciHigh), confidence };
}

module.exports = { continuousKelly, biasAdjustedKelly, bootstrapCI };
