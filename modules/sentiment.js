'use strict';

const https = require('https');
const http  = require('http');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── FINRA RegSHO Short Volume API ─────────────────────────────────────────────
// Source: https://api.finra.org/data/group/otcMarket/name/regShoDaily
// No API key required for basic queries. Returns last 10 days of short volume.
async function fetchFINRAShortVolume(symbol) {
  // FINRA RegSHO free API (no auth) only covers OTC securities.
  // Major listed equities/ETFs (SPY, QQQ, TSLA, etc.) are NOT available here.
  // We return unavailable and rely on put/call ratio from the options chain instead.
  try {
    const filter = encodeURIComponent(JSON.stringify([
      { fieldName: 'securitiesInformationProcessorSymbolIdentifier', compareType: 'equal', fieldValue: symbol }
    ]));
    const url = `https://api.finra.org/data/group/otcMarket/name/regShoDaily?compareFilters=${filter}&limit=20`;

    const res  = await httpGet(url, { Accept: 'application/json' });
    if (res.status !== 200) throw new Error(`FINRA API ${res.status}`);

    const data = JSON.parse(res.body);
    if (!Array.isArray(data) || !data.length) return { available: false };

    const rows = data.map(r => ({
      date:       r.tradeReportDate,
      shortVol:   parseInt(r.shortParQuantity  ?? '0', 10),
      totalVol:   parseInt(r.totalParQuantity  ?? '0', 10),
      shortRatio: parseInt(r.totalParQuantity) > 0
        ? parseInt(r.shortParQuantity) / parseInt(r.totalParQuantity)
        : null,
    })).filter(r => r.totalVol > 0).sort((a, b) => a.date.localeCompare(b.date));

    if (!rows.length) return { available: false };

    const latest      = rows[rows.length - 1];
    const rolling5d   = rows.slice(-5);
    const avgShortRatio = rolling5d.reduce((s, r) => s + (r.shortRatio ?? 0), 0) / rolling5d.length;
    const prev5dRatio   = rows.length > 10
      ? rows.slice(-10, -5).reduce((s, r) => s + (r.shortRatio ?? 0), 0) / 5
      : avgShortRatio;

    // Signal: rising short ratio = bearish; falling = bullish
    // Short ratio > 55% = heavy shorting = contrarian bullish (or bearish momentum)
    // We use change in short ratio as the signal
    const changePct  = prev5dRatio > 0 ? (avgShortRatio - prev5dRatio) / prev5dRatio : 0;

    // Rising short selling → near-term bearish, but extreme short = contrarian bull
    let signal = 0;
    if (avgShortRatio > 0.58 && changePct > 0.05)       signal = -1;  // heavy + rising = bearish
    else if (avgShortRatio > 0.58 && changePct <= 0)     signal = +1;  // extreme short + falling = contrarian bull
    else if (avgShortRatio < 0.42 && changePct < -0.05)  signal = +1;  // light + falling = bullish
    else if (changePct > 0.08)                           signal = -0.5; // rising shorts = mild bear

    const score = Math.max(-10, Math.min(10, signal * 5));

    return {
      available:      true,
      symbol,
      shortRatio:     latest.shortRatio,
      avgShortRatio5d: avgShortRatio,
      shortRatioPctChg: changePct,
      signal,
      score,
      label: signal > 0 ? 'CONTRARIAN_BULL' : signal < 0 ? 'SHORT_PRESSURE' : 'NEUTRAL',
      latestDate: latest.date,
      rows: rows.slice(-10),
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn('[FINRA] fetch failed:', e.message);
    return { available: false, error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ── AAII Sentiment Survey ─────────────────────────────────────────────────────
// AAII publishes weekly bull/bear survey at aaii.com/files/surveys/sentiment.xls
// XLS parsing without external libs is hard. We scrape the summary from their page.
async function fetchAAIISentiment() {
  try {
    const res = await httpGet('https://www.aaii.com/sentimentsurvey/sent_results');
    if (res.status !== 200) throw new Error(`AAII ${res.status}`);

    const html = res.body;

    // Parse bull/bear/neutral % from HTML table
    // Look for pattern: <td>XX.X%</td> in the sentiment table
    const pctPattern = /(\d+\.\d+)%/g;
    const matches = [...html.matchAll(pctPattern)].map(m => parseFloat(m[1]));

    // AAII page typically shows: Bullish, Neutral, Bearish as first three percentages
    if (matches.length < 3) throw new Error('AAII parse: not enough % values');

    // Find the first three in reasonable range (each 0-100, sum ~100)
    let bullish = null, neutral = null, bearish = null;
    for (let i = 0; i < matches.length - 2; i++) {
      const a = matches[i], b = matches[i+1], c = matches[i+2];
      if (a > 0 && b > 0 && c > 0 && Math.abs(a + b + c - 100) < 5) {
        bullish = a; neutral = b; bearish = c;
        break;
      }
    }

    if (bullish == null) throw new Error('AAII parse: could not identify bull/bear/neutral');

    const spread = bullish - bearish;

    // Historical thresholds (AAII long-term avg: bull ~37%, bear ~31%)
    // Signal: extreme bearish > 45% = contrarian bullish
    //         extreme bullish > 50% = contrarian bearish
    let signal = 0;
    if (bearish > 45)  { signal = +1;   }
    else if (bearish > 38) { signal = +0.5; }
    else if (bullish > 50) { signal = -1;   }
    else if (bullish > 44) { signal = -0.5; }

    const score = Math.max(-10, Math.min(10, signal * 7));

    return {
      available: true,
      bullish,
      neutral,
      bearish,
      spread,
      signal,
      score,
      label: signal > 0 ? 'EXTREME_BEARISH_CONTRARIAN_BULL' : signal < 0 ? 'EXTREME_BULLISH_CONTRARIAN_BEAR' : 'NEUTRAL',
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn('[AAII] fetch failed:', e.message);
    // Fallback: use Alternative.me for sentiment proxy
    return fetchAlternativeFG();
  }
}

// ── Alternative.me Fear & Greed (crypto proxy for general sentiment) ──────────
async function fetchAlternativeFG() {
  try {
    const res  = await httpGet('https://api.alternative.me/fng/?limit=7');
    const data = JSON.parse(res.body);
    const current = data?.data?.[0];
    if (!current) return { available: false };

    const score = parseInt(current.value);
    const signal = score < 25 ? +1 : score > 75 ? -1 : 0;

    return {
      available: true,
      source: 'alternative.me',
      bullish: score,
      bearish: 100 - score,
      neutral: 0,
      spread: score - 50,
      signal,
      score: Math.max(-10, Math.min(10, signal * 6)),
      label: current.value_classification,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { available: false, error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ── CNN Fear & Greed ──────────────────────────────────────────────────────────
async function fetchCNNFearGreed() {
  try {
    const res = await httpGet(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { Referer: 'https://edition.cnn.com/' }
    );
    const data = JSON.parse(res.body);
    const fg   = data?.fear_and_greed;
    const hist = data?.fear_and_greed_historical?.data ?? [];

    const score  = fg?.score ?? null;
    const rating = fg?.rating ?? null;

    let signal = 0;
    if (score !== null) {
      if (score < 20)      signal = +1.0;
      else if (score < 35) signal = +0.5;
      else if (score > 80) signal = -1.0;
      else if (score > 65) signal = -0.5;
    }

    return {
      available: score !== null,
      score,
      rating,
      signal,
      scoreVal: Math.max(-10, Math.min(10, signal * 7)),
      prev1d:  hist.find(h => h.rating)?.y ?? null,
      prev1w:  hist[7]?.y ?? null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { available: false, error: e.message, fetchedAt: new Date().toISOString() };
  }
}

// ── Aggregate sentiment score ─────────────────────────────────────────────────
async function fetchAllSentiment(symbol = 'SPY') {
  const [finra, aaii, cnn] = await Promise.allSettled([
    fetchFINRAShortVolume(symbol),
    fetchAAIISentiment(),
    fetchCNNFearGreed(),
  ]);

  const get = r => r.status === 'fulfilled' ? r.value : { available: false };

  return {
    finra:    get(finra),
    aaii:     get(aaii),
    cnn:      get(cnn),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchFINRAShortVolume, fetchAAIISentiment, fetchCNNFearGreed, fetchAllSentiment };
