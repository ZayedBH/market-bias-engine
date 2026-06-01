'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

// Ensure data/ directory exists for audit log (Railway/Render ephemeral FS)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const {
  fetchPriceHistory,
  fetchOptionsChain,
  fetchCBOEOptionsChain,
  fetchVIXTermStructure,
  fetchMacroData,
  fetchFearGreed,
  fetchMultiAsset,
  fetchIntraday5m,
  fetchOvernightSession,
} = require('./modules/dataFetcher');
const { calculateBias }    = require('./modules/bias');
const { computeFullGEX, computeVolSurface } = require('./modules/gex');
const { computeHurst, ouScore } = require('./modules/hurst');
const { computeVRP, computeVIXTermScore } = require('./modules/volatility');
const { tsmomSignal, crossAssetMomentum, computeOFI } = require('./modules/momentum');
const { computeRegime }    = require('./modules/regime');
const { fetchCOTSignal }   = require('./modules/cot');
const { fetchAllSentiment } = require('./modules/sentiment');
const { checkAlerts, getAlerts, clearAlerts } = require('./modules/alerts');
const { backtestSignal }   = require('./modules/backtester');
const { computeSectorBreadth, computeCreditSpread, computeReturnDistribution, computeVolumeProfile, computeCorrelationMatrix } = require('./modules/breadth');
const { logPrediction, resolveOutcomes, getSignalIC, getLogStats } = require('./modules/auditLog');
const { runWalkForward }   = require('./modules/walkForward');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = new Map();
function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: now }); return data; });
}

const TTL = { bias: 5 * 60e3, price: 2 * 60e3, options: 5 * 60e3, vix: 5 * 60e3, macro: 15 * 60e3 };

// ── Error wrapper ─────────────────────────────────────────────────────────────
function apiHandler(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[API error]', err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// ── /api/price ────────────────────────────────────────────────────────────────
app.get('/api/price', apiHandler(async req => {
  const symbol   = (req.query.symbol ?? 'SPY').toUpperCase();
  const range    = req.query.range ?? '1y';
  const interval = req.query.interval ?? '1d';
  return cached(`price:${symbol}:${range}:${interval}`, TTL.price, () =>
    fetchPriceHistory(symbol, range, interval)
  );
}));

// ── /api/options ──────────────────────────────────────────────────────────────
app.get('/api/options', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`options:${symbol}`, TTL.options, () => fetchOptionsChain(symbol));
}));

// ── /api/gex ─────────────────────────────────────────────────────────────────
app.get('/api/gex', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`gex:${symbol}`, TTL.options, async () => {
    const chain = await fetchOptionsChain(symbol);
    return computeFullGEX(chain);
  });
}));

// ── /api/vix ─────────────────────────────────────────────────────────────────
app.get('/api/vix', apiHandler(async req => {
  return cached('vix', TTL.vix, () => fetchVIXTermStructure());
}));

// ── /api/macro ────────────────────────────────────────────────────────────────
app.get('/api/macro', apiHandler(async req => {
  return cached('macro', TTL.macro, () =>
    Promise.all([fetchMacroData(), fetchFearGreed()]).then(([macro, fg]) => ({ ...macro, fearGreed: fg }))
  );
}));

// ── /api/regime ───────────────────────────────────────────────────────────────
app.get('/api/regime', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`regime:${symbol}`, TTL.price, async () => {
    const [bars, vix] = await Promise.all([
      fetchPriceHistory(symbol, '1y'),
      fetchVIXTermStructure(),
    ]);
    const closes = bars.map(b => b.close);
    return computeRegime(symbol, closes, vix.vix);
  });
}));

// ── /api/volatility ───────────────────────────────────────────────────────────
app.get('/api/volatility', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`vol:${symbol}`, TTL.price, async () => {
    const [bars, vix] = await Promise.all([
      fetchPriceHistory(symbol, '6mo'),
      fetchVIXTermStructure(),
    ]);
    const yzVol = require('./modules/volatility').yangZhangVol(bars, 20);
    const gkVol = require('./modules/volatility').garmanKlassVol(bars, 20);
    const vrp   = computeVRP(bars, vix.vix, 20);
    const vixTS = computeVIXTermScore(vix);
    const hurst = computeHurst(bars.map(b => b.close));

    const closes = bars.map(b => b.close);
    const ouVIX = ouScore('VIX', (vix.series?.vix ?? []).map(d => d.close).filter(Boolean));

    return { yzVol, gkVol, vrp, vixTerm: vixTS, hurst, ouVIX, vixRaw: vix };
  });
}));

// ── /api/momentum ─────────────────────────────────────────────────────────────
app.get('/api/momentum', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`momentum:${symbol}`, TTL.price, async () => {
    const bars   = await fetchPriceHistory(symbol, '2y');
    const closes = bars.map(b => b.close);
    const multi  = await fetchMultiAsset().catch(() => ({}));

    return {
      tsmom:      tsmomSignal(closes, [21, 63, 126, 252]),
      crossAsset: crossAssetMomentum(multi),
      ofi:        computeOFI(bars, 14),
      intraday:   require('./modules/momentum').intradayMomentumScore(bars),
      pdh:        require('./modules/momentum').pdhPdlScore(bars),
      ema:        require('./modules/momentum').emaStackScore(closes),
      vwap:       require('./modules/momentum').vwapZScore(bars, 20),
    };
  });
}));

// ── /api/bias ─────────────────────────────────────────────────────────────────
// Main endpoint — computes all 9 modules and returns full composite
app.get('/api/bias', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();

  return cached(`bias:${symbol}`, TTL.bias, async () => {
    console.log(`[bias] computing for ${symbol}…`);

    const [bars, vixData, multi, macroData] = await Promise.all([
      fetchPriceHistory(symbol, '1y'),
      fetchVIXTermStructure(),
      fetchMultiAsset().catch(() => ({})),
      fetchMacroData().catch(() => ({})),
    ]);

    // 5-minute intraday bars — best-effort for ORB / intraday seasonality signals.
    // For futures (ES=F) use the proxy ETF ticker so Yahoo Finance returns data.
    const FUTURES_GEX_PROXY = {
      'ES=F':'SPY','MES=F':'SPY','NQ=F':'QQQ','MNQ=F':'QQQ','RTY=F':'IWM','YM=F':'DIA'
    };
    const intradaySymbol = FUTURES_GEX_PROXY[symbol] ?? symbol;
    let bars5m = null;
    try { bars5m = await fetchIntraday5m(intradaySymbol); }
    catch (e) { console.warn(`[bias] 5m bars unavailable for ${intradaySymbol}:`, e.message); }

    const chainSymbol = intradaySymbol;
    const spotPrice   = bars.at(-1)?.close ?? 0;

    // ── Options chain: CBOE CDN first, Yahoo Finance fallback ────────────────
    // CBOE provides pre-computed delta+gamma from exchange models — more accurate
    // than our Newton-Raphson IV solve on Yahoo Finance's adjusted prices.
    // CBOE updates every 15 min during RTH; Yahoo Finance is our fallback when
    // CBOE CDN is unreachable (e.g. outside US market hours or network issues).
    let chain = null;
    let chainSource = 'none';
    try {
      chain = await fetchCBOEOptionsChain(chainSymbol, spotPrice);
      chainSource = 'cboe';
      console.log(`[bias] options chain: CBOE (${chain.calls.length + chain.puts.length} contracts)`);
    } catch (cboeErr) {
      console.warn(`[bias] CBOE chain failed for ${chainSymbol}: ${cboeErr.message} — falling back to Yahoo Finance`);
      try {
        chain = await fetchOptionsChain(chainSymbol);
        chainSource = 'yahoo';
        console.log(`[bias] options chain: Yahoo Finance fallback`);
      } catch (yfErr) {
        console.warn(`[bias] options chain unavailable for ${chainSymbol}:`, yfErr.message);
      }
    }

    const result = await calculateBias(symbol, chain, bars, vixData, multi, bars5m, macroData);
    result.chainSource = chainSource;

    // Fire alert checks + audit log asynchronously (don't block the response)
    setImmediate(() => {
      try {
        const resultForAlerts = {
          ...result,
          gex: result.gex ? { gexRegime: result.signals?.gexRegime?.detail } : null,
        };
        checkAlerts(symbol, resultForAlerts);
      } catch (e) {
        console.warn('[alerts] check failed:', e.message);
      }
      try {
        logPrediction(result);
      } catch (e) {
        console.warn('[auditLog] logPrediction failed:', e.message);
      }
    });

    return result;
  });
}));

// ── /api/quant ────────────────────────────────────────────────────────────────
// Full quant analytics page data
app.get('/api/quant', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();

  return cached(`quant:${symbol}`, TTL.bias, async () => {
    const [bars, vixData, macro] = await Promise.all([
      fetchPriceHistory(symbol, '1y'),
      fetchVIXTermStructure(),
      fetchMacroData().catch(() => ({})),
    ]);

    const closes = bars.map(b => b.close);
    const hurst  = computeHurst(closes);

    const ouSpreads = {
      vix:   ouScore('VIX',  (vixData.series?.vix ?? []).map(d => d.close).filter(Boolean)),
      vwap:  (() => {
        // Build VWAP spread series from bars
        const vwapSeries = [];
        let totalVol = 0, totalPV = 0;
        for (const b of bars.slice(-60)) {
          totalVol += b.volume;
          totalPV  += ((b.high + b.low + b.close) / 3) * b.volume;
          const vwap = totalPV / (totalVol || 1);
          vwapSeries.push(b.close - vwap);
        }
        return ouScore('VWAP_Spread', vwapSeries);
      })(),
    };

    if (macro.yieldSpreadSeries?.length) {
      ouSpreads.yield = ouScore('YieldSpread', macro.yieldSpreadSeries.map(d => d.value));
    }

    const vrp   = computeVRP(bars, vixData.vix, 20);
    const vixTS = computeVIXTermScore(vixData);
    const multi = await fetchMultiAsset().catch(() => ({}));
    const ca    = crossAssetMomentum(multi);
    const tsmom = tsmomSignal(closes, [21, 63, 126, 252]);
    const vixSeriesQuant = (vixData?.series?.vix ?? []).map(d => d.close).filter(Boolean);
    const regime = computeRegime(symbol, closes, vixSeriesQuant, vixData.vix, null);
    const fearGreed = await fetchFearGreed().catch(() => ({}));

    const distribution  = computeReturnDistribution(bars, 252);
    const volumeProfile = computeVolumeProfile(bars, 60);

    return {
      symbol,
      hurst,
      ouSpreads,
      vrp,
      vixTerm:  vixTS,
      vixRaw:   vixData,
      crossAsset: ca,
      tsmom,
      regime,
      macro,
      fearGreed,
      distribution,
      volumeProfile,
      computedAt: new Date().toISOString(),
    };
  });
}));

// ── /api/cot ─────────────────────────────────────────────────────────────────
app.get('/api/cot', apiHandler(async req => {
  return cached('cot', 12 * 60 * 60e3, () => fetchCOTSignal());
}));

// ── /api/sentiment ────────────────────────────────────────────────────────────
app.get('/api/sentiment', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`sentiment:${symbol}`, 30 * 60e3, () => fetchAllSentiment(symbol));
}));

// ── /api/volsurface ───────────────────────────────────────────────────────────
app.get('/api/volsurface', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`volsurface:${symbol}`, TTL.options, async () => {
    // Fetch more expirations for a richer surface (up to 6)
    const chain = await fetchOptionsChain(symbol);
    return computeVolSurface(chain, chain.spot);
  });
}));

// ── /api/alerts ───────────────────────────────────────────────────────────────
app.get('/api/alerts', apiHandler(async req => {
  const symbol = req.query.symbol?.toUpperCase() ?? null;
  const type   = req.query.type ?? null;
  const since  = req.query.since ?? null;
  const limit  = parseInt(req.query.limit ?? '100', 10);
  return getAlerts({ symbol, type, since, limit });
}));

app.delete('/api/alerts', apiHandler(async req => {
  const symbol = req.query.symbol?.toUpperCase() ?? null;
  clearAlerts(symbol);
  return { cleared: true };
}));

// ── /api/breadth ─────────────────────────────────────────────────────────────
// Sector breadth, credit spread, return distribution, volume profile
app.get('/api/breadth', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();

  return cached(`breadth:${symbol}`, TTL.price, async () => {
    const [bars, multi] = await Promise.all([
      fetchPriceHistory(symbol, '1y'),
      fetchMultiAsset().catch(() => ({})),
    ]);

    const breadth        = computeSectorBreadth(multi);
    const creditSpread   = computeCreditSpread(multi);
    const distribution   = computeReturnDistribution(bars, 252);
    const volumeProfile  = computeVolumeProfile(bars, 60);
    const corrMatrix     = computeCorrelationMatrix(multi, 60);

    // 5m intraday — best effort, non-blocking
    let intraday5m = null;
    try { intraday5m = await fetchIntraday5m(symbol); } catch {}

    return {
      symbol,
      breadth,
      creditSpread,
      distribution,
      volumeProfile,
      corrMatrix,
      intraday5m: intraday5m
        ? intraday5m.slice(-100).map(b => ({ date: b.date, close: b.close, volume: b.volume }))
        : null,
      computedAt: new Date().toISOString(),
    };
  });
}));

// ── /api/intraday ─────────────────────────────────────────────────────────────
app.get('/api/intraday', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  return cached(`intraday:${symbol}`, 2 * 60e3, () => fetchIntraday5m(symbol));
}));

// ── /api/backtest ─────────────────────────────────────────────────────────────
app.get('/api/backtest', apiHandler(async req => {
  const symbol  = (req.query.symbol  ?? 'SPY').toUpperCase();
  const lookback = parseInt(req.query.lookback ?? '30', 10);
  return cached(`backtest:${symbol}:${lookback}`, TTL.price, async () => {
    const bars = await fetchPriceHistory(symbol, '2y');
    return backtestSignal(bars, lookback);
  });
}));

// ── /api/bias (augmented: run alerts after computing) ─────────────────────────
// Override to fire alert check after each bias computation
// (the existing /api/bias route stays, we patch it after)

// ── /api/ic — live signal IC from audit log ───────────────────────────────────
// Returns Spearman IC and IC_IR per signal from resolved live predictions.
// Builds up over time — need 10+ resolved predictions before signals appear.
app.get('/api/ic', apiHandler(async req => {
  const symbol = req.query.symbol?.toUpperCase() ?? null;
  const days   = parseInt(req.query.days ?? '120', 10);
  const stats  = getLogStats();
  const ic     = getSignalIC(symbol, days);
  return { ...ic, logStats: stats };
}));

// ── /api/validate — walk-forward validation on OHLCV signals ─────────────────
// Fetches 5y of daily bars and runs walk-forward (252-bar window, 63-bar step).
// SLOW (~15-30s) — not cached, run on demand. Covers 23 OHLCV-computable signals.
// Options/COT/sentiment signals require /api/ic (live audit log accumulation).
app.get('/api/validate', apiHandler(async req => {
  const symbol = (req.query.symbol ?? 'SPY').toUpperCase();
  console.log(`[validate] walk-forward validation for ${symbol}…`);
  const bars = await fetchPriceHistory(symbol, '5y', '1d');
  if (!bars || bars.length < 300) throw new Error(`Insufficient history: ${bars?.length ?? 0} bars`);
  return runWalkForward(bars);
}));

// ── /api/status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const logStats = getLogStats();
  res.json({
    ok:      true,
    version: '2.1.0',
    uptime:  process.uptime(),
    cached:  cache.size,
    auditLog: logStats,
    time:    new Date().toISOString(),
  });
});

// ── Serve SPA pages ───────────────────────────────────────────────────────────
app.get('/backtest', (req, res) => res.sendFile(path.join(__dirname, 'public', 'backtest.html')));
app.get('/quant',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'quant.html')));
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  Market Bias Engine v2.1 — http://localhost:${PORT}`);
  console.log(`  Quant Analytics         — http://localhost:${PORT}/quant`);
  console.log(`  Backtester              — http://localhost:${PORT}/backtest`);
  console.log(`  Note: started with --max-http-header-size=131072 for Yahoo Finance\n`);

  // Pre-warm COT cache in background — the CFTC ZIP download takes ~10-30s.
  // Warm both ES (13874A) and NQ (209742) so futures traders don't block on first request.
  setTimeout(() => {
    console.log('[startup] Pre-warming COT cache (ES + NQ)…');
    const { ES_CODE, NQ_CODE } = require('./modules/cot');
    fetchCOTSignal(ES_CODE)
      .then(r => r.available
        ? console.log(`[startup] ES COT ready — ${r.weeks} weeks, last date: ${r.lastDate}`)
        : console.log('[startup] ES COT unavailable:', r.error ?? 'no data'))
      .catch(e => console.warn('[startup] ES COT pre-warm failed:', e.message));
    fetchCOTSignal(NQ_CODE)
      .then(r => r.available
        ? console.log(`[startup] NQ COT ready — ${r.weeks} weeks, last date: ${r.lastDate}`)
        : console.log('[startup] NQ COT unavailable:', r.error ?? 'no data'))
      .catch(e => console.warn('[startup] NQ COT pre-warm failed:', e.message));

    // Also pre-warm sentiment (FINRA + AAII + CNN)
    const { fetchAllSentiment } = require('./modules/sentiment');
    fetchAllSentiment('SPY')
      .then(() => console.log('[startup] Sentiment cache warmed'))
      .catch(e => console.warn('[startup] Sentiment pre-warm failed:', e.message));

    // Bias pre-warm: compute composite for QQQ so first user request is fast
    const BIAS_PREWARM = ['QQQ'];
    for (const sym of BIAS_PREWARM) {
      console.log(`[bias] computing for ${sym}…`);
      fetchPriceHistory(sym, '1y')
        .then(async bars => {
          const vixData = await fetchVIXTermStructure().catch(() => ({}));
          const multi   = await fetchMultiAsset().catch(() => ({}));
          const macro   = await fetchMacroData().catch(() => ({}));
          const result  = await calculateBias(sym, null, bars, vixData, multi, null, macro);
          cache.set(`bias:${sym}`, { data: result, ts: Date.now() });
        })
        .catch(e => console.warn(`[startup] bias pre-warm failed for ${sym}:`, e.message));
    }
  }, 1000); // 1s delay so the server is fully ready first

  // Hourly audit log outcome resolution: for predictions older than 23h,
  // fetch realized next-day return and fill in nextDayReturn field.
  // This enables live IC computation and eventual composite calibration.
  setInterval(async () => {
    try {
      const { resolved } = await resolveOutcomes(fetchPriceHistory);
      if (resolved > 0) console.log(`[auditLog] resolved ${resolved} outcome(s)`);
    } catch (e) {
      console.warn('[auditLog] hourly resolution failed:', e.message);
    }
  }, 60 * 60 * 1000); // every hour
});
