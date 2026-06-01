'use strict';

const { greeks, impliedVol } = require('./blackScholes');

const RISK_FREE = 0.053; // approximate current fed funds rate — update periodically

function daysToExpiry(expirationTimestamp) {
  const now = Date.now() / 1000;
  return Math.max(0, (expirationTimestamp - now) / 86400);
}

function yearsToExpiry(dte) {
  return dte / 365;
}

// ── Compute Greeks for a single contract ─────────────────────────────────────
function contractGreeks(contract, spot, type) {
  const K   = contract.strike;
  const dte = daysToExpiry(contract.expiration);
  const T   = yearsToExpiry(dte);

  const oi = (contract.openInterest ?? 0) > 0
    ? contract.openInterest
    : (contract.volume ?? 0);

  // ── Fast path: CBOE pre-computed Greeks ──────────────────────────────────────
  // When chain._source === 'cboe', delta and gamma come directly from CBOE's own
  // pricing models. Skip the NR IV solver entirely — it can't be more accurate
  // than the exchange's own Greeks. We still compute vanna and charm from the
  // CBOE-provided sigma so VEX and CHEX signals remain valid.
  if (contract._source === 'cboe' &&
      contract.delta != null && contract.gamma != null) {
    const sigma  = contract.impliedVolatility > 0.005 ? contract.impliedVolatility : 0.20;
    const cboeG  = greeks(spot, K, RISK_FREE, sigma, T, type);  // for vanna + charm only
    const gammaCap = Math.min(0.30, 5 / (spot * Math.sqrt(Math.max(dte, 0.5) / 252)));
    return {
      delta:  contract.delta,
      gamma:  Math.min(Math.abs(contract.gamma ?? 0), gammaCap) * Math.sign(contract.gamma ?? 1),
      vanna:  cboeG.vanna,   // ∂Δ/∂σ — computed from CBOE IV, not solved
      charm:  cboeG.charm,   // ∂Δ/∂t
      vega:   contract.vega  ?? cboeG.vega,
      iv:     sigma,
      dte, K, oi,
      vol:    contract.volume ?? 0,
    };
  }

  // ── Standard path: Yahoo Finance chain — IV solve → BSM ──────────────────────
  const chainIV  = contract.impliedVolatility ?? 0;
  const bid      = contract.bid  ?? 0;
  const ask      = contract.ask  ?? 0;
  const mid      = bid > 0 || ask > 0 ? (bid + ask) / 2 : (contract.lastPrice ?? 0);
  const mktPrice = mid > 0 ? mid : (contract.lastPrice ?? 0);

  const intrinsic  = type === 'call' ? Math.max(0, spot - K) : Math.max(0, K - spot);
  const isDeepITM  = mktPrice > 0 && (mktPrice - intrinsic) < 0.05;
  const isShortOTM = dte < 1 && Math.abs(spot - K) / spot > 0.05;
  const skipNR     = isDeepITM || isShortOTM;

  let sigma;
  if (chainIV > 0.01 && !isDeepITM)       sigma = chainIV;
  else if (mktPrice > 0 && T > 0 && !skipNR) sigma = impliedVol(mktPrice, spot, K, RISK_FREE, T, type);
  else                                        sigma = chainIV > 0.01 ? chainIV : 0.25;

  const g        = greeks(spot, K, RISK_FREE, sigma, T, type);
  const gammaCap = Math.min(0.30, 5 / (spot * Math.sqrt(Math.max(dte, 0.5) / 252)));
  if (g.gamma > gammaCap) g.gamma = gammaCap;

  return { ...g, iv: sigma, dte, K, oi, vol: contract.volume ?? 0 };
}

// ── GEX per strike ────────────────────────────────────────────────────────────
// Formula: GEX = Gamma × OI × 100 × S² × 0.01
// Call GEX is positive (dealers long gamma), Put GEX is negative (dealers short gamma)
function computeGEXProfile(chain, spot) {
  const { calls, puts } = chain;
  const strikeMap = {};

  const add = (contract, type) => {
    const g = contractGreeks(contract, spot, type);
    const K = g.K;
    if (!strikeMap[K]) strikeMap[K] = { strike: K, gexCall: 0, gexPut: 0, dexCall: 0, dexPut: 0, vexCall: 0, vexPut: 0, chexCall: 0, chexPut: 0, oiCall: 0, oiPut: 0 };

    const dollarGEX = g.gamma * g.oi * 100 * spot * spot * 0.01;
    const dollarDEX = g.delta * g.oi * 100 * spot;
    const dollarVEX = g.vanna * g.oi * 100 * spot;
    const dollarCHEX = g.charm * g.oi * 100;

    if (type === 'call') {
      strikeMap[K].gexCall  += dollarGEX;
      strikeMap[K].dexCall  += dollarDEX;
      strikeMap[K].vexCall  += dollarVEX;
      strikeMap[K].chexCall += dollarCHEX;
      strikeMap[K].oiCall   += g.oi;
    } else {
      // Dealer is short put = short gamma → negative GEX contribution
      strikeMap[K].gexPut   -= dollarGEX;
      strikeMap[K].dexPut   += dollarDEX; // put delta is negative, adds to total
      strikeMap[K].vexPut   += dollarVEX;
      strikeMap[K].chexPut  += dollarCHEX;
      strikeMap[K].oiPut    += g.oi;
    }
  };

  calls.forEach(c => add(c, 'call'));
  puts.forEach(p => add(p, 'put'));

  const profile = Object.values(strikeMap).map(s => ({
    ...s,
    netGEX:  s.gexCall + s.gexPut,
    netDEX:  s.dexCall + s.dexPut,
    netVEX:  s.vexCall + s.vexPut,
    netCHEX: s.chexCall + s.chexPut,
  })).sort((a, b) => a.strike - b.strike);

  return profile;
}

// ── Aggregate totals ──────────────────────────────────────────────────────────
function aggregateTotals(profile) {
  const totGEX  = profile.reduce((s, r) => s + r.netGEX,  0);
  const totDEX  = profile.reduce((s, r) => s + r.netDEX,  0);
  const totVEX  = profile.reduce((s, r) => s + r.netVEX,  0);
  const totCHEX = profile.reduce((s, r) => s + r.netCHEX, 0);
  return { totGEX, totDEX, totVEX, totCHEX };
}

// ── Gamma concentration: % of total |GEX| within ±1% of spot ─────────────────
// High concentration → options are tightly clustered near current price.
// Interpretation:
//   > 50%: very high pin risk — small spot move could cascade
//   30-50%: moderate concentration — expect sticky behaviour near current strike
//   < 20%: distributed profile — smoother dealer hedging, less pin risk
// Source: Inspiration from Squeezemetrics GEX whitepapers; practitioner rule of thumb.
function computeGammaConcentration(profile, spot) {
  if (!profile?.length || !spot) return null;
  const bandLo    = spot * 0.99;
  const bandHi    = spot * 1.01;
  const nearAbs   = profile
    .filter(r => r.strike >= bandLo && r.strike <= bandHi)
    .reduce((s, r) => s + Math.abs(r.netGEX), 0);
  const totalAbs  = profile.reduce((s, r) => s + Math.abs(r.netGEX), 0);
  if (totalAbs < 1) return null;
  const pct = nearAbs / totalAbs;
  return {
    pct:     Math.round(pct * 1000) / 10,   // e.g. 42.7 (%)
    label:   pct > 0.50 ? 'HIGH_PIN'
           : pct > 0.30 ? 'MODERATE'
           : 'DISTRIBUTED',
    nearAbs,
    totalAbs,
    // Signal: high concentration in negative GEX = acceleration risk (cascade)
    //         high concentration in positive GEX  = strong pin
    score: null,   // set by caller after totGEX sign is known
  };
}

// ── Gamma flip: nearest strike to spot where per-strike net GEX sign changes ─
// Convention: find the zero-crossing in net GEX profile CLOSEST to current spot.
// This is the actionable level where dealers flip from long to short gamma (or vice versa).
function findGammaFlip(profile, spot) {
  const sorted = [...profile].sort((a, b) => a.strike - b.strike);
  let bestFlip = spot;
  let bestDist = Infinity;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    // Detect sign change in per-strike net GEX
    if ((prev.netGEX >= 0 && curr.netGEX < 0) || (prev.netGEX < 0 && curr.netGEX >= 0)) {
      const dGEX = curr.netGEX - prev.netGEX;
      const frac = Math.abs(dGEX) > 0 ? -prev.netGEX / dGEX : 0.5;
      const flip = prev.strike + (curr.strike - prev.strike) * Math.max(0, Math.min(1, frac));
      const dist = Math.abs(flip - spot);
      if (dist < bestDist) {
        bestDist = dist;
        bestFlip = flip;
      }
    }
  }

  return bestFlip;
}

// ── Call wall: strike with max GEX-weighted call OI within 20% above spot ────
// Uses GEX-weighted OI (OI × abs(gamma)) so near-ATM strikes dominate over
// massive but near-zero-gamma far-OTM positions.
function findCallWall(profile, spot) {
  const cap     = spot * 1.20;
  const nearby  = profile.filter(r => r.strike >= spot && r.strike <= cap);
  const pool    = nearby.length ? nearby : profile.filter(r => r.strike >= spot);
  if (!pool.length) return spot;
  // Score = OI × GEX magnitude (more GEX = more dealer hedging pressure)
  const scored = pool.map(r => ({
    strike: r.strike,
    score:  r.oiCall * (Math.abs(r.gexCall) + 1),
  }));
  return scored.reduce((best, r) => r.score > best.score ? r : best, scored[0]).strike;
}

// ── Put wall: strike with max GEX-weighted put OI within 15% below spot ──────
// Cap at 15% OTM — beyond that it's tail hedges, not actionable support.
function findPutWall(profile, spot) {
  const floor   = spot * 0.85;
  const nearby  = profile.filter(r => r.strike <= spot && r.strike >= floor);
  const pool    = nearby.length ? nearby : profile.filter(r => r.strike <= spot);
  if (!pool.length) return spot;
  const scored  = pool.map(r => ({
    strike: r.strike,
    score:  r.oiPut * (Math.abs(r.gexPut) + 1),
  }));
  return scored.reduce((best, r) => r.score > best.score ? r : best, scored[0]).strike;
}

// ── Max pain: strike where total OI losses are minimized for option buyers ───
function findMaxPain(profile, spot) {
  const strikes = profile.map(r => r.strike);
  let minPain = Infinity, maxPainStrike = spot;

  for (const testStrike of strikes) {
    let totalPain = 0;
    for (const row of profile) {
      // Call OI pain at testStrike
      if (testStrike > row.strike) totalPain += (testStrike - row.strike) * row.oiCall * 100;
      // Put OI pain at testStrike
      if (testStrike < row.strike) totalPain += (row.strike - testStrike) * row.oiPut * 100;
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = testStrike; }
  }
  return maxPainStrike;
}

// ── 25-Delta Risk Reversal ────────────────────────────────────────────────────
// RR = IV(25Δ call) - IV(25Δ put)  — normal equity index RR is negative
function compute25DeltaRR(chain, spot) {
  const { calls, puts } = chain;

  // Use lastPrice as fallback when bid=ask=0; accept volume>0 as proxy for OI
  const callsWith = calls.filter(c =>
    (c.impliedVolatility > 0.01 || c.lastPrice > 0) && c.strike > 0
  );
  const putsWith = puts.filter(p =>
    (p.impliedVolatility > 0.01 || p.lastPrice > 0) && p.strike > 0
  );

  // Find closest to 0.25 delta call (above spot)
  const callCandidates = callsWith.map(c => {
    const g = contractGreeks(c, spot, 'call');
    return { ...c, delta: g.delta, iv: g.iv };
  });
  const putCandidates = putsWith.map(p => {
    const g = contractGreeks(p, spot, 'put');
    return { ...p, delta: g.delta, iv: g.iv };
  });

  const call25 = callCandidates.reduce((best, c) => {
    return Math.abs(c.delta - 0.25) < Math.abs(best.delta - 0.25) ? c : best;
  }, callCandidates[0] ?? { iv: 0 });

  const put25 = putCandidates.reduce((best, p) => {
    return Math.abs(p.delta + 0.25) < Math.abs(best.delta + 0.25) ? p : best;
  }, putCandidates[0] ?? { iv: 0 });

  const rrRaw = (call25?.iv ?? 0) - (put25?.iv ?? 0); // typically negative

  // Score: less negative = fear abating = bullish; more negative = fear = bearish
  const rrScore = Math.max(-10, Math.min(10, rrRaw * 50)); // scale to -10..+10

  return {
    rr: rrRaw,
    call25dIV: call25?.iv ?? 0,
    put25dIV:  put25?.iv ?? 0,
    score:     rrScore,
    skewRegime: rrRaw < -0.08 ? 'EXTREME_FEAR' : rrRaw < -0.04 ? 'NORMAL' : 'COMPLACENCY',
  };
}

// ── DEX bias ──────────────────────────────────────────────────────────────────
function computeDEXBias(totals, spot) {
  const { totDEX } = totals;
  const magnitude = Math.abs(totDEX) / 1e9;
  return {
    netDEX:    totDEX,
    bias:      totDEX > 0 ? 'BULLISH' : 'BEARISH',
    magnitude,
    score:     Math.max(-10, Math.min(10, (totDEX / 1e10) * 10)),
  };
}

// ── Soft-atan scaler: maps any real ratio to (-10, +10) without hard clamping ─
// f(x) = (2/π) × atan(x × k) × 10  — asymptotically approaches ±10
function atanScore(ratio, k = 5) {
  return (2 / Math.PI) * Math.atan(ratio * k) * 10;
}

// ── VEX post-event signal ─────────────────────────────────────────────────────
// Normalize VEX relative to total GEX+DEX magnitude; use atan scaling to avoid
// hard clamping at ±10 — allows meaningful gradation across all market conditions.
function computeVEXBias(totals) {
  const { totVEX, totGEX, totDEX } = totals;
  // Reference: combined dollar-equivalent exposure; fallback to $100M
  const ref = Math.abs(totGEX) + Math.abs(totDEX) + 1e8;
  const vexRatio = totVEX / ref;
  // atan(k=3) → ratio of 0.5 → score ≈ ±5.5, ratio of 1.0 → score ≈ ±8.3
  const score = atanScore(vexRatio, 3);
  return {
    netVEX: totVEX,
    vexRatio,
    interpretation: totVEX > 0 ? 'BUY_ON_VOL_CRUSH' : 'SELL_ON_VOL_CRUSH',
    score,
  };
}

// ── CHEX expiry bias ──────────────────────────────────────────────────────────
// Normalize CHEX relative to GEX/DTE; use atan scaling.
function computeCHEXBias(totals, avgDTE) {
  const { totCHEX, totGEX } = totals;
  const expiryWeek = avgDTE <= 5;
  const amplifier  = expiryWeek ? Math.max(1, (7 - avgDTE) / 3) : 1;
  // CHEX (charm × OI × 100) normalized by daily-gamma rate: GEX / DTE
  const ref = Math.abs(totGEX) / Math.max(avgDTE, 1) + 1e6;
  const chexRatio = totCHEX / ref;
  // atan(k=2) with amplifier for expiry week
  const score = atanScore(chexRatio * amplifier, 2);
  return {
    netCHEX: totCHEX,
    chexRatio,
    expiryWeek,
    avgDTE,
    amplifier,
    driftBias: totCHEX > 0 ? 'UP' : 'DOWN',
    score,
  };
}

// ── GEX regime score (above vs below gamma flip) ─────────────────────────────
function computeGEXRegimeScore(totals, spot, gammaFlip) {
  const { totGEX } = totals;
  const aboveFlip = spot > gammaFlip;
  const gexBillions = totGEX / 1e9;

  // Positive total GEX = pinning/vol suppression environment
  // Negative total GEX = dealers amplify moves (vol expansion)
  let score;
  if (totGEX > 0) {
    // Positive GEX: range-bound, spot tends to revert to gamma flip
    score = aboveFlip ? -2 : 2; // slight mean-reversion bias
  } else {
    // Negative GEX: dealers amplify moves, follow the direction
    score = aboveFlip ? 3 : -3;
  }

  return {
    totalGEX: totGEX,
    gexBillions,
    aboveFlip,
    gammaFlip,
    gexRegime: totGEX > 0 ? 'POSITIVE_GEX' : 'NEGATIVE_GEX',
    score,
  };
}

// ── Put/Call Ratio ────────────────────────────────────────────────────────────
// P/C volume: short-term sentiment (today's flow)
// P/C OI: structural positioning (accumulated)
// Contrarian: P/C > 1.3 = extreme fear = bullish; P/C < 0.6 = complacency = bearish
function computePutCallRatio(chain) {
  const { calls, puts } = chain;

  const callVol = calls.reduce((s, c) => s + (c.volume ?? 0), 0);
  const putVol  = puts.reduce( (s, p) => s + (p.volume ?? 0), 0);
  const callOI  = calls.reduce((s, c) => s + (c.openInterest ?? 0), 0);
  const putOI   = puts.reduce( (s, p) => s + (p.openInterest ?? 0), 0);

  const pcVol = callVol > 0 ? putVol / callVol : null;
  const pcOI  = callOI  > 0 ? putOI  / callOI  : null;

  // Use whichever ratio is available; prefer volume (more real-time)
  const pc = pcVol ?? pcOI ?? 1.0;

  // Contrarian signal: high P/C = fear = contrarian bullish
  let signal = 0, label = 'NEUTRAL';
  if      (pc > 1.5)  { signal = +1.5; label = 'EXTREME_FEAR';      }
  else if (pc > 1.15) { signal = +0.8; label = 'ELEVATED_PUT';      }
  else if (pc < 0.55) { signal = -1.5; label = 'EXTREME_COMPLACENCY';}
  else if (pc < 0.75) { signal = -0.8; label = 'LOW_HEDGING';       }

  // Soft-scale to ±10
  const score = Math.round((2 / Math.PI) * Math.atan(signal * 4) * 10);

  return {
    putCallVol:  pcVol != null ? Math.round(pcVol * 1000) / 1000 : null,
    putCallOI:   pcOI  != null ? Math.round(pcOI  * 1000) / 1000 : null,
    putCallUsed: Math.round(pc * 1000) / 1000,
    callVol, putVol, callOI, putOI,
    signal, label, score,
  };
}

// ── Full GEX module output ─────────────────────────────────────────────────────
function computeFullGEX(chain) {
  const spot    = chain.spot;
  const profile = computeGEXProfile(chain, spot);
  const totals  = aggregateTotals(profile);

  const gammaFlip = findGammaFlip(profile, spot);
  const callWall  = findCallWall(profile, spot);
  const putWall   = findPutWall(profile, spot);
  const maxPain   = findMaxPain(profile, spot);

  // Average DTE across all contracts
  const allContracts = [...chain.calls, ...chain.puts];
  const avgDTE = allContracts.length
    ? allContracts.reduce((s, c) => s + daysToExpiry(c.expiration), 0) / allContracts.length
    : 30;

  const gexRegime    = computeGEXRegimeScore(totals, spot, gammaFlip);
  const dexBias      = computeDEXBias(totals, spot);
  const vexBias      = computeVEXBias(totals);
  const chexBias     = computeCHEXBias(totals, avgDTE);
  const rr25d        = compute25DeltaRR(chain, spot);
  const putCallRatio = computePutCallRatio(chain);

  const concentration = computeGammaConcentration(profile, spot);
  if (concentration) {
    // Score: high concentration in positive GEX = pinning (slightly bearish for momentum)
    //        high concentration in negative GEX = cascade risk (bearish)
    const isPositive = totals.totGEX > 0;
    const raw = isPositive
      ? -(concentration.pct / 100) * 4          // pin: −4 max (suppresses MR slightly)
      : -(concentration.pct / 100) * 8;         // cascade risk: −8 max
    concentration.score = Math.max(-10, Math.min(0, raw));
  }

  return {
    spot,
    profile,
    totals,
    keyLevels: { gammaFlip, callWall, putWall, maxPain },
    gexRegime,
    dexBias,
    vexBias,
    chexBias,
    rr25d,
    putCallRatio,
    concentration,
    fetchedAt: chain.fetchedAt,
  };
}

// ── Volatility Surface ────────────────────────────────────────────────────────
// Returns a 2-D grid: rows = expirations (sorted by DTE), cols = moneyness buckets
// Each cell: { strike, dte, callIV, putIV, midIV, moneyness }
function computeVolSurface(chain, spot) {
  const { calls, puts } = chain;
  const now = Date.now() / 1000;

  // Group contracts by expiration
  const callsByExp = {};
  const putsByExp  = {};
  calls.forEach(c => {
    const exp = c.expiration;
    if (!callsByExp[exp]) callsByExp[exp] = [];
    callsByExp[exp].push(c);
  });
  puts.forEach(p => {
    const exp = p.expiration;
    if (!putsByExp[exp])  putsByExp[exp]  = [];
    putsByExp[exp].push(p);
  });

  const expirations = [...new Set([...Object.keys(callsByExp), ...Object.keys(putsByExp)])]
    .map(Number)
    .filter(ts => ts > now)
    .sort((a, b) => a - b);

  const surface = [];

  for (const expTs of expirations) {
    const dte = (expTs - now) / 86400;
    if (dte < 0.5) continue;

    const expCalls = callsByExp[expTs] ?? [];
    const expPuts  = putsByExp[expTs]  ?? [];

    // Compute IV per strike
    const strikeIVs = {};
    expCalls.forEach(c => {
      const g = contractGreeks(c, spot, 'call');
      if (g.iv > 0.01 && g.K > 0) {
        if (!strikeIVs[g.K]) strikeIVs[g.K] = {};
        strikeIVs[g.K].callIV = g.iv;
      }
    });
    expPuts.forEach(p => {
      const g = contractGreeks(p, spot, 'put');
      if (g.iv > 0.01 && g.K > 0) {
        if (!strikeIVs[g.K]) strikeIVs[g.K] = {};
        strikeIVs[g.K].putIV = g.iv;
      }
    });

    // Filter: ±25% moneyness, at least one IV side
    const row = Object.entries(strikeIVs)
      .map(([k, ivs]) => {
        const strike = Number(k);
        const moneyness = (strike - spot) / spot;
        const callIV = ivs.callIV ?? null;
        const putIV  = ivs.putIV  ?? null;
        const midIV  = callIV != null && putIV != null
          ? (callIV + putIV) / 2
          : (callIV ?? putIV);
        return { strike, dte, callIV, putIV, midIV, moneyness };
      })
      .filter(r => Math.abs(r.moneyness) <= 0.25 && r.midIV != null)
      .sort((a, b) => a.strike - b.strike);

    if (row.length >= 3) {
      surface.push({ expiration: expTs, dte: Math.round(dte), strikes: row });
    }
  }

  return { spot, surface, fetchedAt: chain.fetchedAt };
}

module.exports = { computeFullGEX, computeGEXProfile, computeGammaConcentration, findGammaFlip, findCallWall, findPutWall, findMaxPain, computeVolSurface };
