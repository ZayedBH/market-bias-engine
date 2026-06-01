'use strict';

// ── Sector Breadth ────────────────────────────────────────────────────────────
// % of SPDR sector ETFs trading above 20d / 50d / 200d EMA
// Breadth above 75% = broad bull; below 25% = broad bear
// Reference: Baker & Wurgler (2006) "Investor Sentiment and the Cross-Section of Stock Returns"

function ema(closes, period) {
  const k = 2 / (period + 1);
  let v = closes[0];
  for (let i = 1; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

const SECTORS = ['XLK','XLF','XLV','XLE','XLI','XLY','XLC','XLB','XLRE','XLU','XLP'];

function computeSectorBreadth(sectorData) {
  let above20 = 0, above50 = 0, above200 = 0, total = 0;
  const details = {};

  for (const ticker of SECTORS) {
    const bars = sectorData[ticker];
    if (!bars?.length) continue;
    const closes = bars.map(b => b.close);
    const spot   = closes[closes.length - 1];
    const e20    = closes.length >= 20  ? ema(closes, 20)  : null;
    const e50    = closes.length >= 50  ? ema(closes, 50)  : null;
    const e200   = closes.length >= 200 ? ema(closes, 200) : null;

    const a20  = e20  != null && spot > e20;
    const a50  = e50  != null && spot > e50;
    const a200 = e200 != null && spot > e200;

    if (a20)  above20++;
    if (a50)  above50++;
    if (a200) above200++;
    total++;

    details[ticker] = {
      spot, e20, e50, e200,
      above20: a20, above50: a50, above200: a200,
      // pct from each EMA for coloring
      pctFrom20:  e20  ? (spot - e20)  / e20  * 100 : null,
      pctFrom50:  e50  ? (spot - e50)  / e50  * 100 : null,
      pctFrom200: e200 ? (spot - e200) / e200 * 100 : null,
    };
  }

  if (!total) return { score: 0, breadthPct: null, available: false, details };

  const p20  = above20  / total;
  const p50  = above50  / total;
  const p200 = above200 / total;
  // Weighted composite: 20d = 0.25, 50d = 0.35, 200d = 0.40
  const breadthPct = 0.25 * p20 + 0.35 * p50 + 0.40 * p200;

  // Score: 0% → -10, 50% → 0, 100% → +10 (linear)
  const score = Math.max(-10, Math.min(10, (breadthPct - 0.5) * 20));

  const regime = breadthPct > 0.75 ? 'BROAD_BULL'
               : breadthPct > 0.55 ? 'MILD_BULL'
               : breadthPct > 0.35 ? 'MIXED'
               : breadthPct > 0.20 ? 'MILD_BEAR'
               : 'BROAD_BEAR';

  return {
    score,
    breadthPct,
    pct20: p20, pct50: p50, pct200: p200,
    above20, above50, above200, total,
    details,
    available: true,
    regime,
    interpretation: `${(breadthPct * 100).toFixed(0)}% wtd avg · ${above200}/${total} above 200d EMA`,
  };
}

// ── Credit Spread Proxy (HYG / IEI ratio z-score) ─────────────────────────────
// HYG = High Yield Corp Bond ETF; IEI = 3-7yr Treasury ETF
// Rising HYG/IEI ratio = tightening spreads = risk-on = bullish
// Falling ratio = widening spreads = risk-off = bearish
// Reference: Collin-Dufresne, Goldstein & Martin (2001) "The Determinants of Credit Spread Changes"

function computeCreditSpread(assetData) {
  const hygBars = assetData['HYG'] ?? [];
  const ieiBars = assetData['IEI'] ?? [];
  const minLen  = Math.min(hygBars.length, ieiBars.length);
  if (minLen < 20) return { score: 0, available: false, interpretation: 'NO_DATA' };

  const hyg = hygBars.slice(-minLen).map(b => b.close);
  const iei = ieiBars.slice(-minLen).map(b => b.close);
  const ratio = [];
  for (let i = 0; i < minLen; i++) {
    if (iei[i] > 0) ratio.push(hyg[i] / iei[i]);
  }
  if (ratio.length < 20) return { score: 0, available: false, interpretation: 'INSUFFICIENT_DATA' };

  const cur  = ratio[ratio.length - 1];
  const hist = ratio.slice(-Math.min(252, ratio.length));
  const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
  const std  = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length);
  const z    = std > 0 ? (cur - mean) / std : 0;

  const prev20 = ratio[Math.max(0, ratio.length - 21)];
  const trend  = prev20 > 0 ? (cur - prev20) / prev20 * 100 : 0; // % change

  // Atan soft-scaling: z=1 → score≈5, z=2 → score≈7.4, z=-1 → score≈-5
  const score = Math.round((2 / Math.PI) * Math.atan(z * 2) * 10);

  return {
    available: true,
    score,
    zScore: z,
    trend,
    current: cur,
    mean,
    std,
    signal: z > 1 ? 'BULL' : z < -1 ? 'BEAR' : 'NEUTRAL',
    interpretation: z > 1 ? 'TIGHT_SPREADS_RISK_ON' : z < -1 ? 'WIDE_SPREADS_RISK_OFF' : 'NEUTRAL_SPREADS',
    detail: `z=${z.toFixed(2)} trend=${trend >= 0 ? '+' : ''}${trend.toFixed(2)}%`,
  };
}

// ── Return Distribution Statistics ───────────────────────────────────────────
// Full tail-risk profile: skewness, excess kurtosis, historical VaR/CVaR, Sharpe, drawdown
// Reference: Cornish & Fisher (1937), Favre & Galeano (2002), Ang & Chen (2002)

function computeReturnDistribution(bars, windowDays = 252) {
  if (!bars?.length || bars.length < 30) return null;

  const closes = bars.slice(-Math.min(windowDays, bars.length)).map(b => b.close);
  const rets   = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;

  const n    = rets.length;
  const mean = rets.reduce((s, v) => s + v, 0) / n;
  const vari = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1);
  const std  = Math.sqrt(vari);
  const annM = mean * 252;
  const annS = std  * Math.sqrt(252);

  // 3rd / 4th standardized moments
  const skew = std > 0 ? rets.reduce((s, v) => s + ((v - mean) / std) ** 3, 0) / n : 0;
  const kurt = std > 0 ? rets.reduce((s, v) => s + ((v - mean) / std) ** 4, 0) / n - 3 : 0;

  // Historical VaR (non-parametric)
  const sorted = [...rets].sort((a, b) => a - b);
  const idx95  = Math.max(0, Math.floor(0.05 * n) - 1);
  const idx99  = Math.max(0, Math.floor(0.01 * n) - 1);
  const var95  = sorted[idx95];
  const var99  = sorted[idx99];

  // CVaR = Expected Shortfall (average of tail losses)
  const cvar95 = idx95 > 0
    ? sorted.slice(0, idx95 + 1).reduce((s, v) => s + v, 0) / (idx95 + 1)
    : var95;

  // Sharpe (rf ≈ 0 for excess return proxy)
  const sharpe = annS > 0 ? annM / annS : 0;

  // Sortino (downside deviation)
  const dnRets  = rets.filter(r => r < 0);
  const downDev = dnRets.length > 0
    ? Math.sqrt(dnRets.reduce((s, v) => s + v * v, 0) / dnRets.length * 252) : 0;
  const sortino = downDev > 0 ? annM / downDev : 0;

  // Max drawdown
  let peak = closes[0], maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Calmar ratio
  const calmar = maxDD !== 0 ? annM / Math.abs(maxDD) : 0;

  // Omega ratio (probability-weighted ratio of gains to losses above threshold=0)
  const gains  = rets.filter(r => r > 0).reduce((s, v) => s + v, 0);
  const losses = rets.filter(r => r < 0).reduce((s, v) => s + Math.abs(v), 0);
  const omega  = losses > 0 ? gains / losses : gains > 0 ? Infinity : 1;

  return {
    n,
    annualizedReturn: annM,
    annualizedVol:    annS,
    skewness:         skew,
    excessKurtosis:   kurt,
    var95:  var95  * 100,   // daily %
    var99:  var99  * 100,
    cvar95: cvar95 * 100,
    sharpe,
    sortino,
    calmar,
    omega: isFinite(omega) ? omega : 99,
    maxDrawdown: maxDD * 100,
    regime:          skew < -0.5 ? 'NEGATIVE_SKEW' : skew > 0.5 ? 'POSITIVE_SKEW' : 'SYMMETRIC',
    kurtosisRegime:  kurt > 3    ? 'FAT_TAILS'     : kurt < -1  ? 'THIN_TAILS'    : 'NORMAL',
  };
}

// ── Volume Profile / VPOC ─────────────────────────────────────────────────────
// Builds a price-vs-volume histogram over the last N bars
// VPOC  = Volume Point of Control (highest volume price level)
// VAH/VAL = Value Area High/Low (70% of volume)
// Reference: Steidlmayer (1984) CBOT Market Profile

function computeVolumeProfile(bars, numBuckets = 60) {
  if (!bars?.length || bars.length < 10) return null;

  const slice = bars.slice(-Math.min(60, bars.length));
  const lo = Math.min(...slice.map(b => b.low));
  const hi = Math.max(...slice.map(b => b.high));
  if (hi <= lo) return null;

  const bSize   = (hi - lo) / numBuckets;
  const buckets = Array.from({ length: numBuckets }, (_, idx) => ({
    price: lo + (idx + 0.5) * bSize,
    pLo:   lo + idx * bSize,
    pHi:   lo + (idx + 1) * bSize,
    vol:   0,
  }));

  // Distribute each bar's volume proportionally over its OHLC range
  for (const bar of slice) {
    if (!bar.volume || !isFinite(bar.high) || !isFinite(bar.low)) continue;
    const range = bar.high - bar.low || 0.001;
    for (const b of buckets) {
      const olLo = Math.max(bar.low, b.pLo);
      const olHi = Math.min(bar.high, b.pHi);
      if (olHi > olLo) b.vol += bar.volume * (olHi - olLo) / range;
    }
  }

  // VPOC
  const vpocB = buckets.reduce((a, b) => b.vol > a.vol ? b : a);
  const vpoc  = vpocB.price;

  // Value Area (70% of total volume, expanding from VPOC)
  const totalVol = buckets.reduce((s, b) => s + b.vol, 0);
  let included = vpocB.vol;
  let li = buckets.indexOf(vpocB);
  let ri = li;

  while (included < totalVol * 0.70) {
    const addLo = li > 0 ? buckets[li - 1].vol : 0;
    const addHi = ri < buckets.length - 1 ? buckets[ri + 1].vol : 0;
    if (addLo === 0 && addHi === 0) break;
    if (addLo >= addHi && li > 0) { li--; included += addLo; }
    else if (ri < buckets.length - 1) { ri++; included += addHi; }
    else break;
  }

  const vah  = buckets[ri].pHi;
  const val  = buckets[li].pLo;
  const spot = slice[slice.length - 1].close;

  return {
    vpoc,
    vah,
    val,
    spot,
    totalVolume: totalVol,
    priceLow:    lo,
    priceHigh:   hi,
    buckets:     buckets.map(b => ({ price: +b.price.toFixed(2), volume: Math.round(b.vol) })),
    spotVsVPOC:  (spot - vpoc) / vpoc * 100,
    spotInValueArea: spot >= val && spot <= vah,
    interpretation:  spot > vah ? 'ABOVE_VALUE_AREA' : spot < val ? 'BELOW_VALUE_AREA' : 'IN_VALUE_AREA',
  };
}

// ── Asset Correlation Matrix ──────────────────────────────────────────────────
// 60-day rolling correlation of log-returns across key assets
// Reference: Ledoit & Wolf (2004) "Honey, I Shrunk the Sample Covariance Matrix"

function computeCorrelationMatrix(assetData, window = 60) {
  const KEY_ASSETS = ['SPY','QQQ','IWM','GLD','TLT','HYG','XLK','XLF','XLV','XLE','XLI'];

  // Build return series aligned by length
  const series = {};
  for (const tk of KEY_ASSETS) {
    const bars = assetData[tk];
    if (!bars?.length) continue;
    const closes = bars.slice(-window - 1).map(b => b.close);
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i-1] > 0) rets.push(Math.log(closes[i] / closes[i-1]));
    }
    if (rets.length >= window * 0.8) series[tk] = rets.slice(-window);
  }

  const tickers = Object.keys(series);
  if (tickers.length < 2) return null;

  // Compute correlation matrix
  const n = Math.min(...tickers.map(t => series[t].length));
  const means = {};
  const stds  = {};
  for (const tk of tickers) {
    const s  = series[tk].slice(-n);
    const m  = s.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(s.reduce((a, v) => a + (v - m) ** 2, 0) / n);
    means[tk] = m;
    stds[tk]  = sd;
  }

  const corr = {};
  for (const ta of tickers) {
    corr[ta] = {};
    const sa = series[ta].slice(-n);
    for (const tb of tickers) {
      if (ta === tb) { corr[ta][tb] = 1.0; continue; }
      const sb = series[tb].slice(-n);
      if (stds[ta] === 0 || stds[tb] === 0) { corr[ta][tb] = 0; continue; }
      let cov = 0;
      for (let i = 0; i < n; i++) {
        cov += (sa[i] - means[ta]) * (sb[i] - means[tb]);
      }
      corr[ta][tb] = cov / (n * stds[ta] * stds[tb]);
    }
  }

  return { tickers, correlations: corr, window: n };
}

// ── Average pairwise correlation ──────────────────────────────────────────────
// Computes the mean off-diagonal correlation across all asset pairs.
// High avgCorr (> 0.65): market moving as one unit → macro/regime signals dominate
// Low avgCorr  (< 0.35): sector dispersion → breadth/relative-strength signals reliable
function computeAvgPairCorr(corrMatrix) {
  if (!corrMatrix?.tickers?.length) return null;
  const { tickers, correlations } = corrMatrix;
  const vals = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const c = correlations[tickers[i]]?.[tickers[j]];
      if (c != null && isFinite(c)) vals.push(c);
    }
  }
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

module.exports = {
  computeSectorBreadth,
  computeCreditSpread,
  computeReturnDistribution,
  computeVolumeProfile,
  computeCorrelationMatrix,
  computeAvgPairCorr,
};
