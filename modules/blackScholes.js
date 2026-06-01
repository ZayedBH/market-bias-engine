'use strict';

// Hart (1968) rational approximation for standard normal CDF — accurate to 7.5e-8
function normCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937;
  const a4 = -1.821255978, a5 = 1.330274429;
  const k = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const w = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) *
    (a1 * k + a2 * k ** 2 + a3 * k ** 3 + a4 * k ** 4 + a5 * k ** 5);
  return x < 0 ? 1 - w : w;
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function d1d2(S, K, r, sigma, T) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return { d1: 0, d2: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2 };
}

function greeks(S, K, r, sigma, T, type = 'call') {
  if (T <= 0 || sigma <= 0) {
    return { delta: 0, gamma: 0, vanna: 0, charm: 0, vega: 0, iv: sigma };
  }
  const { d1, d2 } = d1d2(S, K, r, sigma, T);
  const sqrtT = Math.sqrt(T);
  const phi_d1 = normPDF(d1);
  const N_d1  = normCDF(d1);
  const N_d2  = normCDF(d2);
  const N_nd1 = normCDF(-d1);
  const N_nd2 = normCDF(-d2);

  const gamma = phi_d1 / (S * sigma * sqrtT);

  // Vanna = dDelta/dVol = -phi(d1) * d2 / sigma  (per unit of vol)
  const vanna = -phi_d1 * d2 / sigma;

  // Charm = dDelta/dt = -phi(d1) * [2*r*T - d2*sigma*sqrtT] / (2*T*sigma*sqrtT)
  const charm = type === 'call'
    ? -phi_d1 * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT)
    : -phi_d1 * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);

  const vega = S * phi_d1 * sqrtT;

  if (type === 'call') {
    const delta = N_d1;
    const price = S * N_d1 - K * Math.exp(-r * T) * N_d2;
    return { delta, gamma, vanna, charm, vega, price, iv: sigma, d1, d2 };
  } else {
    const delta = N_d1 - 1;
    const price = K * Math.exp(-r * T) * N_nd2 - S * N_nd1;
    return { delta, gamma, vanna, charm, vega, price, iv: sigma, d1, d2 };
  }
}

// Newton-Raphson implied vol solver (typically converges in 3-5 iterations)
function impliedVol(marketPrice, S, K, r, T, type = 'call', tol = 1e-6, maxIter = 100) {
  if (T <= 0 || marketPrice <= 0) return 0;
  let sigma = 0.3;
  for (let i = 0; i < maxIter; i++) {
    const g = greeks(S, K, r, sigma, T, type);
    const diff = g.price - marketPrice;
    if (Math.abs(diff) < tol) break;
    if (g.vega < 1e-10) { sigma *= 1.5; continue; }
    sigma -= diff / g.vega;
    if (sigma <= 0) sigma = 1e-4;
    if (sigma > 20) sigma = 20;
  }
  return sigma > 0 && sigma < 20 ? sigma : 0;
}

module.exports = { normCDF, normPDF, d1d2, greeks, impliedVol };
