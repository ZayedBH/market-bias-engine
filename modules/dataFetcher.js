'use strict';

const https = require('https');
const http  = require('http');

// ── Yahoo Finance auth state ──────────────────────────────────────────────────
let yfCookies = null;
let yfCrumb   = null;
let yfAuthAt  = 0;
const CRUMB_TTL = 25 * 60 * 1000;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getYFAuth() {
  if (yfCrumb && Date.now() - yfAuthAt < CRUMB_TTL) return { cookies: yfCookies, crumb: yfCrumb };

  // Step 1: get consent cookies
  const base = await httpsGet('https://finance.yahoo.com/', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  const rawCookies = base.headers['set-cookie'] || [];
  const cookieStr  = rawCookies.map(c => c.split(';')[0]).join('; ');

  // Step 2: get crumb
  const crumbRes = await httpsGet('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'text/plain,*/*',
    'Cookie': cookieStr,
    'Referer': 'https://finance.yahoo.com/',
  });

  const crumb = crumbRes.body.trim();
  if (!crumb || crumb.includes('<')) {
    throw new Error('YF crumb fetch failed: ' + crumb.slice(0, 80));
  }

  yfCookies = cookieStr;
  yfCrumb   = encodeURIComponent(crumb);
  yfAuthAt  = Date.now();
  console.log('[YF auth] crumb refreshed:', crumb.slice(0, 10) + '…');
  return { cookies: yfCookies, crumb: yfCrumb };
}

async function yfFetch(path) {
  const { cookies, crumb } = await getYFAuth();
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://query2.finance.yahoo.com${path}${sep}crumb=${crumb}`;
  const res = await httpsGet(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'application/json',
    'Cookie': cookies,
    'Referer': 'https://finance.yahoo.com/',
  });
  if (res.status === 401 || res.status === 403) {
    yfCrumb = null; // force re-auth on next call
    throw new Error(`YF ${res.status} on ${path}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('YF JSON parse error: ' + res.body.slice(0, 120));
  }
}

// ── Price history ─────────────────────────────────────────────────────────────
async function fetchPriceHistory(symbol, range = '1y', interval = '1d') {
  const data = await yfFetch(`/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`No chart data for ${symbol}`);

  const ts = r.timestamp;
  const q  = r.indicators.quote[0];
  const ad = r.indicators.adjclose?.[0]?.adjclose;

  const bars = ts.map((t, i) => ({
    date:     new Date(t * 1000).toISOString().slice(0, 10),
    open:     q.open[i],
    high:     q.high[i],
    low:      q.low[i],
    close:    q.close[i],
    volume:   q.volume[i],
    adjClose: ad?.[i] ?? q.close[i],
  })).filter(r => r.close != null && r.open != null);
  bars._fetchedAt = Date.now();
  return bars;
}

// ── CBOE CDN options chain ────────────────────────────────────────────────────
// Source: cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json
// Free public CDN — no auth required — updates every 15 minutes during market hours.
// Returns pre-computed delta + gamma from CBOE's own models, eliminating our
// Newton-Raphson IV solver for GEX computation. This is the same data powering
// mztrading.netlify.app and similar retail GEX dashboards.
//
// Spot price is NOT in this endpoint — pass it from the existing price fetch.
// IV field is in percentage form (e.g. 18.5 = 18.5% = 0.185 decimal).
//
// Option symbol format: SPY260529C00435000
//   (\w+)  = underlying ticker
//   (\d{6})= YYMMDD expiry
//   ([CP])  = call/put
//   (\d{8})= strike × 1000 (8 digits, zero-padded)
const CBOE_CHAIN_CACHE     = new Map();
const CBOE_CHAIN_CACHE_TTL = 15 * 60 * 1000;  // 15 min — matches CBOE update cadence
const OPTION_SYM_RE        = /^(\w+?)(\d{6})([CP])(\d+)$/;

async function fetchCBOEOptionsChain(symbol, spotPrice) {
  const sym  = symbol.toUpperCase();
  const now  = Date.now();
  const ckey = `cboe:${sym}`;
  const hit  = CBOE_CHAIN_CACHE.get(ckey);
  if (hit && now - hit.ts < CBOE_CHAIN_CACHE_TTL) return hit.data;

  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`;
  const res  = await httpsGet(url, { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' });
  if (res.status !== 200) throw new Error(`CBOE ${sym}: HTTP ${res.status}`);

  let json;
  try { json = JSON.parse(res.body); } catch { throw new Error(`CBOE ${sym}: JSON parse error`); }

  const rawOptions = json?.data?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw new Error(`CBOE ${sym}: empty options array`);
  }

  const nowSec = now / 1000;
  const calls  = [];
  const puts   = [];

  for (const opt of rawOptions) {
    const m = OPTION_SYM_RE.exec(opt.option ?? '');
    if (!m) continue;

    // Parse expiry: YYMMDD → Unix timestamp at 20:00 UTC (4pm ET close)
    const yy   = parseInt(m[2].slice(0, 2), 10);
    const mm   = parseInt(m[2].slice(2, 4), 10) - 1;  // 0-indexed month
    const dd   = parseInt(m[2].slice(4, 6), 10);
    const expTs = Date.UTC(2000 + yy, mm, dd, 20) / 1000;

    const dte = (expTs - nowSec) / 86400;
    if (dte < -1 || dte > 60) continue;  // skip expired + far-dated (>60 DTE)

    const strike = parseInt(m[4], 10) / 1000;
    const type   = m[3] === 'C' ? 'call' : 'put';

    const contract = {
      strike,
      expiration:        expTs,
      impliedVolatility: (opt.iv  ?? 0) / 100,  // % → decimal
      bid:               opt.bid  ?? 0,
      ask:               opt.ask  ?? 0,
      lastPrice:         opt.last_trade_price ?? 0,
      openInterest:      opt.open_interest ?? 0,
      volume:            opt.volume ?? 0,
      // Pre-computed CBOE Greeks — picked up by contractGreeks to skip NR solve
      delta:  opt.delta ?? null,
      gamma:  opt.gamma ?? null,
      vega:   opt.vega  ?? null,
      theta:  opt.theta ?? null,
      _source: 'cboe',
    };

    if (type === 'call') calls.push(contract);
    else                 puts.push(contract);
  }

  if (calls.length === 0 && puts.length === 0) {
    throw new Error(`CBOE ${sym}: no valid contracts after filtering`);
  }

  const chain = {
    spot:      spotPrice,
    expirations: [],   // not critical — used only for display
    calls,
    puts,
    symbol:    sym,
    _source:   'cboe',
    fetchedAt: new Date().toISOString(),
  };

  CBOE_CHAIN_CACHE.set(ckey, { data: chain, ts: now });
  return chain;
}

// ── Options chain ─────────────────────────────────────────────────────────────
// Fetches the nearest 1-3 expirations (0–45 DTE) and aggregates for best GEX signal.
async function fetchOptionsChain(symbol, expirationTs = null) {
  const now = Date.now() / 1000;

  // First pass: get all expirationDates and spot
  const base = await yfFetch(`/v7/finance/options/${symbol}`);
  const r0   = base?.optionChain?.result?.[0];
  if (!r0) throw new Error(`No options data for ${symbol}`);

  const spot        = r0.quote?.regularMarketPrice ?? 0;
  const allExpiries = r0.expirationDates ?? [];

  // If a specific expiry was requested, use it; otherwise pick best expirations.
  // Yahoo Finance does NOT populate openInterest for very near-term options (< 7 DTE).
  // Prefer 7–45 DTE for GEX accuracy; fall back to whatever is available.
  let targetExpiries;
  if (expirationTs) {
    targetExpiries = [expirationTs];
  } else {
    const valid = allExpiries
      .filter(ts => ts > now + 86400)           // must be at least 1 day out
      .sort((a, b) => a - b);
    // First preference: 7–45 DTE (OI usually populated by YF in this range)
    const ideal = valid.filter(ts => {
      const dte = (ts - now) / 86400;
      return dte >= 7 && dte <= 45;
    });
    // Second preference: 1–60 DTE (broader fallback)
    const broad = valid.filter(ts => (ts - now) / 86400 >= 1 && (ts - now) / 86400 <= 60);
    const chosen = ideal.length > 0 ? ideal : broad.length > 0 ? broad : valid;
    targetExpiries = chosen.slice(0, 3);        // up to 3 expirations
  }

  // Fetch each expiry and merge all calls/puts
  const allCalls = [];
  const allPuts  = [];

  for (const ts of targetExpiries) {
    try {
      const data = ts === (allExpiries[0]) && !expirationTs
        ? base   // reuse already-fetched first expiry data
        : await yfFetch(`/v7/finance/options/${symbol}?date=${ts}`);

      const r    = data?.optionChain?.result?.[0];
      const opts = r?.options?.[0] ?? {};
      (opts.calls ?? []).forEach(c => allCalls.push({ ...c, expiration: c.expiration ?? ts, type: 'call' }));
      (opts.puts  ?? []).forEach(p => allPuts.push({  ...p, expiration: p.expiration ?? ts, type: 'put'  }));
    } catch (e) {
      console.warn(`[options] failed for ${symbol} exp=${ts}:`, e.message);
    }
  }

  return {
    spot,
    expirations: allExpiries,
    calls: allCalls,
    puts:  allPuts,
    symbol,
    dteFocus: targetExpiries.map(ts => Math.round((ts - now) / 86400)),
    fetchedAt: new Date().toISOString(),
  };
}

// ── VIX term structure ────────────────────────────────────────────────────────
async function fetchVIXTermStructure() {
  const [vix9d, vix, vix3m, vvix, skew] = await Promise.allSettled([
    fetchPriceHistory('^VIX9D', '3mo'),
    fetchPriceHistory('^VIX',   '3mo'),
    fetchPriceHistory('^VIX3M', '3mo'),
    fetchPriceHistory('^VVIX',  '3mo'),
    fetchPriceHistory('^SKEW',  '3mo'),
  ]);

  const last = arr => arr.value?.at(-1)?.close ?? null;
  const series = arr => (arr.value ?? []).map(d => ({ date: d.date, close: d.close }));

  return {
    vix9d:   last(vix9d),
    vix:     last(vix),
    vix3m:   last(vix3m),
    vvix:    last(vvix),
    skew:    last(skew),
    series: {
      vix9d:  series(vix9d),
      vix:    series(vix),
      vix3m:  series(vix3m),
    },
    contango: last(vix9d) !== null && last(vix) !== null ? last(vix9d) < last(vix) : true,
    termRatio: last(vix9d) && last(vix) ? last(vix9d) / last(vix) : null,
    fetchedAt: new Date().toISOString(),
    _fetchedAt: Date.now(),
  };
}

// ── FRED macro data ───────────────────────────────────────────────────────────
async function fetchFREDSeries(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&vintage_date=&realtime_start=&realtime_end=`;
  const res = await httpsGet(url, { 'User-Agent': 'Mozilla/5.0' });
  const lines = res.body.trim().split('\n').slice(1); // skip header
  return lines.map(l => {
    const [date, val] = l.split(',');
    return { date: date.trim(), value: parseFloat(val) };
  }).filter(r => !isNaN(r.value));
}

async function fetchMacroData() {
  const [t10y2y, fed_rate, dxy, move] = await Promise.allSettled([
    fetchFREDSeries('T10Y2Y'),          // 10Y-2Y yield spread
    fetchFREDSeries('FEDFUNDS'),        // Fed funds rate
    fetchPriceHistory('DX-Y.NYB', '1y'), // DXY (Dollar Index)
    fetchPriceHistory('^MOVE', '3mo'),  // ICE BofA MOVE Index (bond vol)
  ]);

  const lastFred = arr => arr.value?.at(-1) ?? null;
  const lastYF   = arr => arr.value?.at(-1)?.close ?? null;

  return {
    yieldSpread:       lastFred(t10y2y),
    fedRate:           lastFred(fed_rate),
    dxy:               lastYF(dxy),
    move:              lastYF(move),    // MOVE index last close
    yieldSpreadSeries: (t10y2y.value ?? []).slice(-90),
    fetchedAt: new Date().toISOString(),
  };
}

// ── COT data from CFTC ────────────────────────────────────────────────────────
async function fetchCOTData() {
  try {
    // CFTC publishes a weekly CSV of futures-only financial COT data
    const url = 'https://www.cftc.gov/files/dea/history/fut_fin_txt_2024.zip';
    // Note: ZIP parsing requires additional libraries not in scope.
    // Use the JSON API alternative available via Quandl/Nasdaq Data Link free tier
    // Fallback: return cached/mock structure for now
    return {
      available: false,
      note: 'COT data requires Nasdaq Data Link free API key. Set NASDAQ_API_KEY env var.',
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return { available: false, fetchedAt: new Date().toISOString() };
  }
}

// ── CNN Fear & Greed ─────────────────────────────────────────────────────────
async function fetchFearGreed() {
  try {
    const res = await httpsGet(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://edition.cnn.com/' }
    );
    const data = JSON.parse(res.body);
    const current = data?.fear_and_greed;
    return {
      score:  current?.score ?? null,
      rating: current?.rating ?? null,
      prev1d: data?.fear_and_greed_historical?.data?.[1]?.y ?? null,
      prev1w: data?.fear_and_greed_historical?.data?.[7]?.y ?? null,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return { score: null, rating: null, fetchedAt: new Date().toISOString() };
  }
}

// ── Multi-asset price fetch (cross-asset TSMOM + sector breadth + credit spread) ─
// Includes all 11 SPDR sector ETFs, IEI (3-7yr Treasury), and core risk-on/off assets.
async function fetchMultiAsset() {
  const tickers = [
    // Core risk-on / risk-off
    'SPY', 'QQQ', 'IWM', 'GLD', 'TLT', 'HYG', 'XLY', 'SMH',
    // Credit spread proxy (IEI = 3-7yr Treasury vs HYG high-yield)
    'IEI',
    // All 11 SPDR sector ETFs
    'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLC', 'XLB', 'XLRE', 'XLU', 'XLP',
  ];
  const results = await Promise.allSettled(
    tickers.map(t => fetchPriceHistory(t, '1y'))
  );
  const out = {};
  tickers.forEach((t, i) => {
    if (results[i].status === 'fulfilled') out[t] = results[i].value;
  });
  return out;
}

// ── Hourly bars with extended/pre+post market session ────────────────────────
// Used for overnight range on futures (ES, NQ). includePrePost=true gives globex bars.
async function fetchOvernightSession(symbol) {
  const data = await yfFetch(`/v8/finance/chart/${symbol}?interval=1h&range=5d&includePrePost=true`);
  const r = data?.chart?.result?.[0];
  if (!r) return null;

  const ts = r.timestamp;
  const q  = r.indicators.quote[0];

  // Classify each bar: US RTH = 13:30–20:00 UTC (9:30–4PM ET)
  return ts.map((t, i) => {
    const dt  = new Date(t * 1000);
    const h   = dt.getUTCHours();
    const m   = dt.getUTCMinutes();
    const utcMin = h * 60 + m;
    const isRTH  = utcMin >= 13 * 60 + 30 && utcMin < 20 * 60;
    return {
      ts, date: dt.toISOString(),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
      isRTH,
    };
  }).filter(b => b.close != null);
}

// ── 5-minute intraday bars ────────────────────────────────────────────────────
async function fetchIntraday5m(symbol) {
  // Yahoo Finance: interval=5m, range=1d (up to 7d supported)
  const data = await yfFetch(`/v8/finance/chart/${symbol}?interval=5m&range=2d`);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`No 5m data for ${symbol}`);

  const ts = r.timestamp;
  const q  = r.indicators.quote[0];

  return ts.map((t, i) => ({
    ts:     t,
    date:   new Date(t * 1000).toISOString(),
    open:   q.open[i],
    high:   q.high[i],
    low:    q.low[i],
    close:  q.close[i],
    volume: q.volume[i],
  })).filter(b => b.close != null && b.open != null);
}

module.exports = {
  fetchPriceHistory,
  fetchOptionsChain,
  fetchCBOEOptionsChain,
  fetchVIXTermStructure,
  fetchMacroData,
  fetchCOTData,
  fetchFearGreed,
  fetchMultiAsset,
  fetchIntraday5m,
  fetchOvernightSession,
  yfFetch,
};
