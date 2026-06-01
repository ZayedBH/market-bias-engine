'use strict';

const { computeFullGEX }       = require('./gex');
const { computeHurst, ouScore } = require('./hurst');
const { computeVRP, computeVIXTermScore } = require('./volatility');
const {
  tsmomSignal, crossAssetMomentum, pdhPdlScore,
  emaStackScore, computeOFI, intradayMomentumScore, vwapZScore,
  detectFairValueGaps, overnightGapSignal, computeRoundLevels,
} = require('./momentum');
const { computeRegime }        = require('./regime');
const { biasAdjustedKelly, bootstrapCI } = require('./kelly');
const { fetchCOTSignal, ES_CODE, NQ_CODE } = require('./cot');
const { fetchAllSentiment }    = require('./sentiment');
const { computeSectorBreadth, computeCreditSpread, computeCorrelationMatrix, computeAvgPairCorr } = require('./breadth');
const {
  openingRangeSignal,
  standardErrorChannel,
  garchVolatilitySignal,
  entropySignal,
  zScoreMeanReversion,
  vpaDivergence,
  intradaySeasonality,
  mrsmSignal,
  postNewsBehavior,
  skewnessKurtosisSignal,
  fatTailsSignal,
  nonNormalDistSignal,
  cltConvergenceSignal,
  ivSkewSlopeSignal,
  straddleExpectedMoveSignal,
  varianceRatioSignal,
  volSurfaceButterflySignal,
  cvdDivergenceSignal,
  amihudIlliquiditySignal,
  deltaWeightedPCRSignal,
  // New batch-2 signals
  downsideSemivarianceSignal,
  vpinSignal,
  signedOptionFlowSignal,
  skewDeltaSignal,
  opexCycleSignal,
  preEventDriftSignal,
  vrpTermStructureSignal,
  yieldCurveSignal,
  leadLagSignal,
  relativeStrengthSignal,
  zeroDteGexSignal,
} = require('./advanced');
const { getCalendarContext } = require('./calendar');

// ── Futures instrument proxy table ───────────────────────────────────────────
// When trading futures, we use ETF options chains for GEX (Yahoo Finance has no
// futures options data) and route COT to the correct CFTC contract code.
const FUTURES_MAP = {
  'ES=F':  { gexProxy: 'SPY', cotCode: ES_CODE, label: 'E-mini S&P 500'     },
  'MES=F': { gexProxy: 'SPY', cotCode: ES_CODE, label: 'Micro E-mini S&P'   },
  'NQ=F':  { gexProxy: 'QQQ', cotCode: NQ_CODE, label: 'E-mini Nasdaq-100'  },
  'MNQ=F': { gexProxy: 'QQQ', cotCode: NQ_CODE, label: 'Micro E-mini NQ'    },
  'RTY=F': { gexProxy: 'IWM', cotCode: null,    label: 'E-mini Russell 2000' },
  'YM=F':  { gexProxy: 'DIA', cotCode: null,    label: 'E-mini Dow Jones'    },
};

function getFuturesProxy(symbol) {
  return FUTURES_MAP[symbol.toUpperCase()] ?? null;
}

// Signal category → pillar mapping (used for regime weight multipliers)
const SIGNAL_CATEGORIES = {
  gexRegime:    'options_gex',
  gammaFlipBias:'options_gex',
  dexBias:      'options_gex',
  vexEvent:     'options_gex',
  chexExpiry:   'options_gex',
  rr25d:        'options_gex',
  hmmRegime:    'macro',
  hurst:        'trend',
  ouZscore:     'volatility',
  vrp:          'volatility',
  vixTermStruct:'volatility',
  tsmom:        'momentum',
  crossAsset:   'momentum',
  ofi:          'momentum',
  intradayMom:  'momentum',
  pdhPdl:       'trend',
  emaStack:     'trend',
  vwapZscore:   'trend',
  cot:          'macro',
  aaiiSentiment:'macro',
  cnnFG:        'macro',
  putCall:      'options_gex',
  breadth:      'trend',
  creditSpread: 'macro',
  fvg:          'trend',
  overnightGap: 'momentum',
  // Advanced signals
  orb:          'momentum',
  seChannel:    'trend',
  garch:        'volatility',
  entropy:      'volatility',
  zScoreMR:     'trend',
  vpa:          'momentum',
  seasonality:  'momentum',
  mrsm:         'macro',
  postNews:     'momentum',
  // Distribution shape signals
  skewKurt:     'volatility',
  fatTails:     'volatility',
  nonNormal:    'volatility',
  clt:          'trend',
  // Options-flow signals from PDF research
  gammaZone:    'options_gex',
  vannaVRP:     'options_gex',
  charmIntraday:'options_gex',
  ivSkewSlope:  'options_gex',
  straddleMvmt: 'volatility',
  gammaConc:    'options_gex',
  // Hardcore quant additions (batch 1)
  gexSpeed:     'options_gex',
  varRatio:     'trend',
  volButterfly: 'volatility',
  cvdDiverg:    'momentum',
  amihud:       'volatility',
  dpcr:         'options_gex',
  // New signals (batch 2)
  zeroDteGex:   'options_gex',
  signedFlow:   'options_gex',
  skewDelta:    'options_gex',
  opexCycle:    'options_gex',
  downsideSV:   'volatility',
  vpin:         'volatility',
  vrpTermStruct:'volatility',
  yieldCurve:   'macro',
  preEventDrift:'momentum',
  relStrength:  'momentum',
  leadLag:      'momentum',
};

// ── Timeframe classification ──────────────────────────────────────────────────
// Each signal is tagged with the timeframe it primarily reflects.
// Used to derive three separate sub-composites for scalp / session / macro views.
//
// SCALP   — expires within the current session (< ~2h relevance):
//           intraday order-flow, ORB, charm time-weighting, 0DTE gamma,
//           calendar proximity, immediate GEX zone.
//
// SESSION — valid for the current trading day (4–8h):
//           options structure levels (flip, walls, skew, VRP),
//           prior-day structure (PDH/PDL, FVG, overnight gap),
//           mean-reversion from VWAP, short-horizon autocorrelation.
//
// MACRO   — multi-day to multi-week context:
//           regime classification, COT positioning, TSMOM,
//           cross-asset momentum, breadth, yield curve, sentiment.
//
const SIGNAL_TIMEFRAME = {
  // ── SCALP ──────────────────────────────────────────────────────────────
  orb:          'scalp',   // opening-range breakout — today's 9:30-10 AM
  gammaZone:    'scalp',   // spot position vs GEX walls RIGHT NOW
  zeroDteGex:   'scalp',   // same-day expiry gamma — expires tonight
  charmIntraday:'scalp',   // time-of-day dealer hedging — strongest after 2 PM ET
  cvdDiverg:    'scalp',   // 5-min cumulative volume delta
  vpin:         'scalp',   // 5-min informed-trade toxicity
  downsideSV:   'scalp',   // 5-min downside semivariance
  intradayMom:  'scalp',   // open-to-now return z-score
  seasonality:  'scalp',   // time-of-day mean-return pattern
  preEventDrift:'scalp',   // FOMC/CPI/NFP proximity — time-sensitive
  opexCycle:    'scalp',   // OPEX day/week mechanic — session-specific
  ofi:          'scalp',   // order-flow imbalance from current session bars
  signedFlow:   'scalp',   // live option net-buying pressure from chain
  gammaConc:    'session', // concentration of |GEX| near spot — recalculates with chain
  gexSpeed:     'scalp',   // gamma cliff near spot — amplification risk now
  vpa:          'scalp',   // Wyckoff volume-price of last 5 bars

  // ── SESSION ────────────────────────────────────────────────────────────
  gexRegime:    'session', // net GEX sign — valid for the session
  gammaFlipBias:'session', // distance from gamma flip — recalculates each session
  dexBias:      'session', // net dealer delta — options hedge pressure today
  vexEvent:     'session', // vanna exposure — relevant while IV is at current level
  chexExpiry:   'session', // charm across chain — changes with time and price
  rr25d:        'session', // 25-delta risk reversal — current smile shape
  putCall:      'session', // raw P/C ratio — today's chain snapshot
  vannaVRP:     'session', // vanna × VRP cross — current IV direction
  dpcr:         'session', // delta-weighted P/C — current OI positioning
  ivSkewSlope:  'session', // IV slope regression across current chain
  volButterfly: 'session', // wing IV curvature — current smile
  skewDelta:    'session', // day-over-day skew change
  straddleMvmt: 'session', // ATM straddle vs today's realized move
  vrp:          'session', // Vol Risk Premium — 20-day implied vs realized
  vixTermStruct:'session', // VIX9D/VIX/VIX3M contango/backwardation
  vrpTermStruct:'session', // VRP term structure slope + VVIX
  pdhPdl:       'session', // previous-day high/low structure
  fvg:          'session', // ICT fair-value gaps — valid until mitigated
  overnightGap: 'session', // today's open vs yesterday's close
  amihud:       'session', // daily liquidity z-score
  zScoreMR:     'session', // 20-day rolling price z-score
  vwapZscore:   'session', // today's VWAP deviation
  varRatio:     'session', // 4-day autocorrelation test
  seChannel:    'session', // 50-day linear regression channel
  postNews:     'session', // post-release behavior (8:30/10:00 AM windows)
  emaStack:     'session', // EMA alignment — relatively fast to shift

  // ── MACRO ──────────────────────────────────────────────────────────────
  hmmRegime:    'macro',   // 4-state HMM trained on ~1 year daily data
  mrsm:         'macro',   // 2-state Hamilton regime switching
  hurst:        'macro',   // R/S Hurst exponent — long-range dependence
  tsmom:        'macro',   // 21/63/126-day time-series momentum
  crossAsset:   'macro',   // multi-asset momentum across SPY/TLT/GLD/DXY
  cot:          'macro',   // CFTC weekly COT — updates Fridays
  aaiiSentiment:'macro',   // weekly retail sentiment survey
  cnnFG:        'macro',   // Fear & Greed composite — daily, slow-moving
  breadth:      'macro',   // % sector ETFs above 20/50/200d EMA
  creditSpread: 'macro',   // HYG/IEI risk-on/off regime
  yieldCurve:   'macro',   // T10Y2Y + MOVE — changes over weeks
  leadLag:      'macro',   // daily TLT/HYG lagged lead — uses daily bars
  relStrength:  'macro',   // NQ/ES + IWM relative strength — multi-week
  garch:        'macro',   // GARCH(1,1) conditional vol — 60-bar window
  skewKurt:     'macro',   // 60-day return distribution shape
  fatTails:     'macro',   // 120-day tail analysis
  nonNormal:    'macro',   // 80-day Gaussian mixture fit
  entropy:      'macro',   // 100-bar Shannon + permutation entropy
  clt:          'macro',   // 60-bar Berry-Esseen bound
  ouZscore:     'macro',   // OU mean-reversion on VIX series
};

// ── Sub-composite from a filtered signal set ──────────────────────────────────
// Normalises weights within the group and applies the same atan softening.
function subComposite(signals, timeframe) {
  const subset = Object.entries(signals).filter(([k]) => SIGNAL_TIMEFRAME[k] === timeframe);
  if (!subset.length) return { score: 0, label: 'NEUTRAL', n: 0 };

  const totalW = subset.reduce((s, [, sig]) => s + (sig.normalizedWeight ?? 0), 0);
  if (totalW < 1e-10) return { score: 0, label: 'NEUTRAL', n: 0 };

  const raw = subset.reduce((s, [, sig]) => s + sig.score * (sig.normalizedWeight ?? 0) / totalW, 0);
  const score = Math.round((2 / Math.PI) * Math.atan(raw / 5) * 100);

  return { score, label: scoreToLabel(score), n: subset.length };
}

function scoreToLabel(score) {
  if (score >= 65)  return 'STRONG BULL';
  if (score >= 30)  return 'BULL';
  if (score >= -30) return 'NEUTRAL';
  if (score >= -65) return 'BEAR';
  return 'STRONG BEAR';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Main composite bias calculator ───────────────────────────────────────────
async function calculateBias(symbol, chain, bars, vixData, multiAsset = {}, bars5m = null, macroData = null) {
  const closes = bars.map(b => b.close);
  const spot   = closes[closes.length - 1];
  const vixCur = vixData?.vix ?? 20;

  // ── Futures instrument detection ─────────────────────────────────────────────
  const futProxy  = getFuturesProxy(symbol);
  const isFutures = futProxy != null;
  // cotCode: use instrument-specific code (ES vs NQ) when known
  const cotCode   = futProxy?.cotCode ?? ES_CODE;

  // ── Data freshness check ─────────────────────────────────────────────────────
  // Each data source stamps _fetchedAt at fetch time. If a source is older than
  // its max staleness threshold (e.g. during a market fast-move with cache delays),
  // flag the composite as DEGRADED so consumers know to discount the output.
  const now_ms = Date.now();
  const dataQualityIssues = [];
  const priceAgeMs   = bars._fetchedAt   ? now_ms - bars._fetchedAt   : 0;
  const optionsAgeMs = chain?.fetchedAt  ? now_ms - new Date(chain.fetchedAt).getTime() : 0;
  const vixAgeMs     = vixData?._fetchedAt ? now_ms - vixData._fetchedAt : 0;
  const MAX_PRICE_MS   = 10 * 60_000;   // 10 min
  const MAX_OPTIONS_MS = 15 * 60_000;   // 15 min
  const MAX_VIX_MS     = 10 * 60_000;   // 10 min
  if (priceAgeMs   > MAX_PRICE_MS)   dataQualityIssues.push(`price ${Math.round(priceAgeMs/60000)}m old`);
  if (optionsAgeMs > MAX_OPTIONS_MS) dataQualityIssues.push(`options ${Math.round(optionsAgeMs/60000)}m old`);
  if (vixAgeMs     > MAX_VIX_MS)    dataQualityIssues.push(`VIX ${Math.round(vixAgeMs/60000)}m old`);

  // ── Module computations (parallel where possible) ────────────────────────
  const gex      = chain ? computeFullGEX(chain) : null;
  // gexScale: converts proxy ETF prices (SPY/QQQ) to futures price space.
  // Hoisted here so it can be used in both the signal table and key-level scaling.
  const proxySpot = gex?.spot;
  const gexScale  = (isFutures && proxySpot && proxySpot > 0) ? (spot / proxySpot) : 1;
  const hurstR   = computeHurst(closes);
  const vixSeries = (vixData?.series?.vix ?? []).map(d => d.close).filter(Boolean);
  const ouVIX    = ouScore('VIX', vixSeries);
  const vrp      = computeVRP(bars, vixCur, 20);
  const vixTerm  = computeVIXTermScore(vixData ?? {});

  // ── Regime: for futures use proxy ETF closes so HMM trains on the same
  //    price series as the options/GEX data, ensuring consistent regime detection.
  //    Also pass: (1) actual VIX series — flat scalar → z-score collapses to 0,
  //    (2) GEX context — gamma flip is the #1 intraday driver for ES/NQ.
  const proxySymbol = futProxy?.gexProxy;
  const proxyBars   = proxySymbol && multiAsset[proxySymbol];
  const regimeCloses = (isFutures && proxyBars?.length >= 60)
    ? proxyBars.map(b => b.close)
    : closes;
  const regimeSymbol = (isFutures && proxyBars?.length >= 60) ? proxySymbol : symbol;

  const gexContext = gex ? {
    spot:      gex.spot,
    gammaFlip: gex.keyLevels?.gammaFlip,
    totalGEX:  gex.totals?.totGEX,
    pcRatio:   gex.putCallRatio?.putCallUsed,
  } : null;

  const regime = computeRegime(regimeSymbol, regimeCloses, vixSeries, vixCur, gexContext);
  const tsmom    = tsmomSignal(closes, [21, 63, 126]);
  const crossAss       = Object.keys(multiAsset).length > 1 ? crossAssetMomentum(multiAsset) : null;
  const sectorBreadth  = Object.keys(multiAsset).length > 5 ? computeSectorBreadth(multiAsset) : null;
  const creditSpreadSig = computeCreditSpread(multiAsset);
  const ofi      = computeOFI(bars, 14);
  const intraday = intradayMomentumScore(bars);
  const pdh      = pdhPdlScore(bars);
  const emas     = emaStackScore(closes);
  const vwap     = vwapZScore(bars, 20);
  // FVG + overnight gap — always computed, more relevant for futures
  const fvgResult  = detectFairValueGaps(bars, 60);
  const overnight  = overnightGapSignal(bars);
  const roundLvls  = computeRoundLevels(spot, symbol);

  // ── Advanced signals (pure math — synchronous, no network) ────────────────
  // These run regardless of instrument type.  For ORB/seasonality, we use
  // the 5m intraday bars when available (passed in from server.js), and fall
  // back gracefully when they are not.
  const nowTs      = bars5m?.at(-1)?.ts ?? Math.floor(Date.now() / 1000);
  // Calendar context: computed once, used by multiple signals
  const cal = getCalendarContext(nowTs);
  const proxySpotForChain = gex?.spot ?? spot;

  const adv = {
    orb:        openingRangeSignal(bars5m),
    seChannel:  standardErrorChannel(closes, 50),
    garch:      garchVolatilitySignal(closes),
    entropy:    entropySignal(closes),
    zScoreMR:   zScoreMeanReversion(closes, 20),
    vpa:        vpaDivergence(bars, 20),
    seasonality: intradaySeasonality(nowTs),
    mrsm:       mrsmSignal(closes),
    postNews:   postNewsBehavior(nowTs),
    // Distribution shape signals — skewness, fat tails, non-normality, CLT
    skewKurt:   skewnessKurtosisSignal(closes, 60),
    fatTails:   fatTailsSignal(closes, 120),
    nonNormal:  nonNormalDistSignal(closes, 80),
    clt:        cltConvergenceSignal(closes, 60),
    // Options-flow signals using raw chain data (proxy spot for futures)
    ivSkewSlope:  chain ? ivSkewSlopeSignal(chain, proxySpotForChain)               : { score: 0, available: false, detail: 'No chain' },
    straddleMvmt: chain ? straddleExpectedMoveSignal(chain, proxySpotForChain, bars) : { score: 0, available: false, detail: 'No chain' },
    // Hardcore quant additions (batch 1)
    varRatio:     varianceRatioSignal(closes, 4),
    volButterfly: chain ? volSurfaceButterflySignal(chain, proxySpotForChain)        : { score: 0, available: false, detail: 'No chain' },
    cvdDiverg:    cvdDivergenceSignal(bars5m, 20),
    amihud:       amihudIlliquiditySignal(bars, 25),
    dpcr:         chain ? deltaWeightedPCRSignal(chain, proxySpotForChain)           : { score: 0, available: false, detail: 'No chain' },
    // New signals (batch 2)
    downsideSV:   downsideSemivarianceSignal(bars5m, 40),
    vpin:         vpinSignal(bars5m, 50),
    signedFlow:   chain ? signedOptionFlowSignal(chain, proxySpotForChain)           : { score: 0, available: false, detail: 'No chain' },
    // skewDelta uses gex.rr25d.rr and ivSkewSlope.slope — computed after gex is ready
    skewDelta:    { score: 0, available: false, detail: 'Pending skew inputs' },
    opexCycle:    opexCycleSignal(cal),
    preEventDrift: preEventDriftSignal(cal),
    vrpTermStruct: vrpTermStructureSignal(vixData),
    yieldCurve:   yieldCurveSignal(macroData),
    leadLag:      leadLagSignal(multiAsset),
    relStrength:  relativeStrengthSignal(multiAsset),
    zeroDteGex:   chain ? zeroDteGexSignal(chain, proxySpotForChain)                 : { score: 0, available: false, detail: 'No chain' },
  };

  // Skew delta: now that ivSkewSlope is computed, update the pending entry
  if (gex && adv.ivSkewSlope.available) {
    adv.skewDelta = skewDeltaSignal(gex.rr25d?.rr ?? null, adv.ivSkewSlope.slope ?? null);
  }

  // COT + sentiment: network-bound, run in parallel with a hard timeout so they
  // never block the composite. COT has a 12h module-level cache — once warm it
  // resolves in <1ms. Sentiment scrapes 2-3 endpoints (~1-3s).
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

  const [cotResult, sentResult] = await Promise.allSettled([
    withTimeout(fetchCOTSignal(cotCode),   4000), // ES code or NQ code depending on instrument
    withTimeout(fetchAllSentiment(symbol), 8000), // scraping budget
  ]);
  const cot       = cotResult.status === 'fulfilled'  ? cotResult.value  : { available: false };
  const sentiment = sentResult.status === 'fulfilled' ? sentResult.value : {};

  // ── Build signal table with weights ─────────────────────────────────────
  const signals = {};

  if (gex) {
    signals.gexRegime  = { score: gex.gexRegime.score,     weight: 0.10, label: 'GEX Regime',       category: 'options_gex', detail: gex.gexRegime.gexRegime };

    // ── Gamma Flip vs Spot — direct composite signal ──────────────────────────
    // The gamma flip is where dealer net gamma crosses zero.
    // Above flip: dealers are long gamma → they BUY dips (put wall support active) → BULLISH bias
    // Below flip: dealers are short gamma → they SELL dips (amplify moves down)   → BEARISH bias
    // Score scales with how far spot is from the flip (atan-softened).
    // This is elevated weight for futures since it's the #1 intraday level for ES/NQ.
    {
      const flip   = gex.keyLevels?.gammaFlip;
      const gexSpotNow = gex.spot; // proxy spot (SPY/QQQ for futures)
      if (flip && gexSpotNow) {
        const pct      = (gexSpotNow - flip) / flip;            // % above/below flip
        // Above flip = bullish (dealers support dips), below = bearish (dealers amplify)
        // But also consider GEX sign: positive GEX above flip = strong support; negative GEX = weaker
        const gexSign  = gex.totals?.totGEX > 0 ? 1 : -1;
        const rawScore = (2 / Math.PI) * Math.atan(pct / 0.005) * 10; // 0.5% = half signal
        const flipScore = Math.max(-10, Math.min(10, rawScore * (gexSign > 0 ? 1.0 : 0.6)));
        const flipWeight = isFutures ? 0.08 : 0.05; // elevated for ES/NQ
        const aboveBelow = pct >= 0 ? 'ABOVE' : 'BELOW';
        const proxyScale = (isFutures && gex.spot && gex.spot > 0) ? (spot / gex.spot) : 1;
        signals.gammaFlipBias = {
          score:    flipScore,
          weight:   flipWeight,
          label:    'Gamma Flip Bias',
          category: 'options_gex',
          detail:   `${aboveBelow} flip (${(pct*100).toFixed(2)}%) | flip=${(flip*proxyScale).toFixed(0)}`,
        };
      }
    }

    // DEX bias: atan-scale so it never saturates.
    // totDEX for SPY is ~$22B; linear scale (/ 1e10) always hits the ±10 cap.
    // atan(totDEX / 15B) maps: 15B → ±6.4, 30B → ±8.5, ∞ → ±10
    const dexAtanScore = (2 / Math.PI) * Math.atan(gex.dexBias.netDEX / 15e9) * 10;
    signals.dexBias    = { score: dexAtanScore,             weight: 0.07, label: 'DEX Bias',          category: 'options_gex', detail: `${gex.dexBias.bias} $${(gex.dexBias.netDEX/1e9).toFixed(1)}B` };

    signals.vexEvent   = { score: gex.vexBias.score,       weight: 0.04, label: 'VEX (Vol-Crush)',   category: 'options_gex', detail: gex.vexBias.interpretation };
    signals.chexExpiry = { score: gex.chexBias.score,      weight: 0.03, label: 'CHEX Expiry',       category: 'options_gex', detail: `DTE ${gex.chexBias.avgDTE?.toFixed(0)}d` };
    signals.rr25d      = { score: gex.rr25d.score,         weight: 0.05, label: '25Δ Risk Reversal', category: 'options_gex', detail: `RR ${(gex.rr25d.rr * 100).toFixed(1)}% (${gex.rr25d.skewRegime})` };
    signals.putCall    = { score: gex.putCallRatio.score,  weight: 0.05, label: 'Put/Call Ratio',    category: 'options_gex', detail: `P/C ${gex.putCallRatio.putCallUsed?.toFixed(2)} ${gex.putCallRatio.label}` };

    // ── Gamma Zone: spot position relative to wall structure ──────────────────
    // GammaStudySimple1: the zone spot occupies defines dealer behavior and
    // expected price action character (pinning vs acceleration).
    // Complements gammaFlipBias (which is a smooth distance signal) with a
    // categorical zone regime.  Elevated weight for futures (ES/NQ walls dominate).
    {
      const { gammaFlip, callWall, putWall } = gex.keyLevels;
      const proxyS = gex.spot;
      if (gammaFlip && callWall && putWall && proxyS) {
        let zoneScore = 0, zoneName = 'UNKNOWN';
        const isPositiveGEX = (gex.totals?.totGEX ?? 0) > 0;
        if (proxyS > callWall) {
          // Positive GEX: dealers long gamma → they SELL as spot rises above call wall
          //   (their calls go deeper ITM, requiring more short stock to delta-hedge) → vol suppression / fade
          // Negative GEX: dealers short gamma → still selling below but forced to BUY
          //   above the call wall (gamma squeeze) → momentum continuation upward
          zoneScore = isPositiveGEX ? -2 : +3;
          zoneName  = 'ABOVE_CALL_WALL';
        } else if (proxyS > gammaFlip) {
          // Positive gamma zone: dealers buy dips → pin/MR bias.
          // This is a STABILITY environment, not a strongly directional one.
          // Dealers support dips but also sell rips → mild bullish tilt, not +4→+7.
          // Previous +4→+7 created a persistent structural long bias whenever GEX>0,
          // which is the most common intraday state and inflated the composite.
          const frac = (callWall > gammaFlip) ? (proxyS - gammaFlip) / (callWall - gammaFlip) : 0.5;
          zoneScore  = 1 + frac * 2;    // +1 near flip → +3 approaching call wall
          zoneName   = 'POSITIVE_GAMMA';
        } else if (proxyS > putWall) {
          // Negative gamma zone: dealers sell dips → pro-cyclical → momentum / acceleration.
          const frac = (gammaFlip > putWall) ? (gammaFlip - proxyS) / (gammaFlip - putWall) : 0.5;
          zoneScore  = -(4 + frac * 4); // -4 near flip → -8 approaching put wall
          zoneName   = 'NEGATIVE_GAMMA';
        } else {
          // Below put wall: explosive selling regime (vol trigger / gamma cascade).
          zoneScore = -9;
          zoneName  = 'BELOW_PUT_WALL';
        }
        const sc = gex.spot > 0 ? spot / gex.spot : 1; // same as gexScale
        signals.gammaZone = {
          score:    clamp(zoneScore, -10, 10),
          weight:   isFutures ? 0.07 : 0.05,
          label:    'Gamma Zone',
          category: 'options_gex',
          detail:   `${zoneName} | put=${(putWall*sc).toFixed(0)} flip=${(gammaFlip*sc).toFixed(0)} call=${(callWall*sc).toFixed(0)}`,
        };
      }
    }

    // ── Charm Intraday: time-of-day weighted charm flow ───────────────────────
    // From Dealerz: charm (∂Δ/∂t) causes option deltas to decay over the trading
    // day.  Dealers must re-hedge this decay.  Effect is maximal near market close
    // (0DTE gamma / delta collapse accelerates in the final 30 minutes of RTH).
    // Positive net CHEX near close → dealers sell futures → intraday bearish pressure.
    {
      const rawCharm = gex.totals.totCHEX;
      // ET decimal hour (DST-aware)
      const etH = (() => {
        const d  = new Date(nowTs * 1000);
        const yr = d.getUTCFullYear();
        const m8  = new Date(Date.UTC(yr,  2, 1)).getUTCDay();
        const m11 = new Date(Date.UTC(yr, 10, 1)).getUTCDay();
        const dstS = new Date(Date.UTC(yr,  2, 8 + (7 - m8)  % 7, 7));
        const dstE = new Date(Date.UTC(yr, 10, 1 + (7 - m11) % 7, 6));
        const off  = (d >= dstS && d < dstE) ? -4 : -5;
        const ed   = new Date(nowTs * 1000 + off * 3_600_000);
        return ed.getUTCHours() + ed.getUTCMinutes() / 60;
      })();
      // Time-of-day weight: strongest in final 30 min of RTH, weak mid-day
      const charmTW = etH >= 15.5 ? 1.0
                    : etH >= 15.0 ? 0.7
                    : etH >= 14.0 ? 0.4
                    : etH >= 9.5  ? 0.2
                    : 0.05;
      // Only wire in this signal during market hours (weight ≥ 0.04 threshold)
      const charmWeight = charmTW >= 0.7 ? 0.06 : charmTW >= 0.35 ? 0.04 : 0;
      if (charmWeight > 0) {
        // Positive CHEX → dealers sell delta → bearish; negate for score direction
        const charmScore = (2 / Math.PI) * Math.atan(-rawCharm * charmTW / 2e7) * 10;
        signals.charmIntraday = {
          score:    clamp(charmScore, -10, 10),
          weight:   charmWeight,
          label:    'Charm Intraday',
          category: 'options_gex',
          detail:   `CHEX=${(rawCharm / 1e6).toFixed(0)}M tw=${charmTW.toFixed(1)} etH=${etH.toFixed(1)} → ${rawCharm > 0 ? 'SELL' : 'BUY'}_PRESSURE`,
        };
      }
    }

    // ── GEX Speed / Gamma Cliff: d(netGEX)/dS at current spot ────────────────
    // GEX speed measures how rapidly the dealer's aggregate gamma position changes
    // as spot moves through the current strike neighborhood.  A "gamma cliff" — a
    // zone where the GEX profile has a steep gradient — indicates:
    //   • Dealers will need to dramatically re-hedge after only a small spot move
    //   • Vol expansion and feedback loops are more likely near these cliffs
    //   • High speed = unstable hedging = bearish for pinning; amplifies directional moves
    //
    // Computed as an inverse-distance-weighted derivative of netGEX vs strike,
    // centred on the proxy spot.  High weighted speed → negative score (vol expansion risk).
    {
      const profile = gex.profile;  // sorted by strike, already on proxy spot
      if (profile && profile.length >= 3) {
        const proxyS = gex.spot;
        let wSpeed = 0, wTotal = 0;
        for (let i = 1; i < profile.length; i++) {
          const dK   = profile[i].strike - profile[i - 1].strike;
          if (dK <= 0) continue;
          const speed = Math.abs(profile[i].netGEX - profile[i - 1].netGEX) / dK;
          // Gaussian kernel centred on proxy spot: σ = 4% moneyness.
          // At 4% OTM weight = e^-1 ≈ 0.37; at 8% OTM weight ≈ 0.14.
          const midK  = (profile[i].strike + profile[i - 1].strike) / 2;
          const dist  = Math.abs(midK - proxyS) / proxyS;
          const w     = Math.exp(-dist / 0.04);  // 4% bandwidth
          wSpeed += speed * w;
          wTotal += w;
        }
        if (wTotal > 0) {
          const avgSpeed  = wSpeed / wTotal;                // $/strike
          // GEX speed is always ≥ 0 (abs values) so the score is always ≤ 0.
          // This is intentional: any significant gamma cliff is a vol-expansion risk,
          // which is bearish for mean-reversion strategies.  The signal is SILENT
          // (not added to signals table) when the profile is smooth (|score| < 1)
          // so it doesn't dilute the composite with a meaningless near-zero entry.
          // atan scale — 1e8 $/pt ≈ half scale for a typical SPY chain.
          const speedScore = -(2 / Math.PI) * Math.atan(avgSpeed / 1e8) * 10;
          const cliffLabel = Math.abs(speedScore) > 5 ? 'GAMMA_CLIFF'
                           : Math.abs(speedScore) > 2 ? 'STEEP_GRADIENT'
                           : 'SMOOTH';
          if (Math.abs(speedScore) >= 1) {   // only fire when cliff is meaningful
            signals.gexSpeed = {
              score:    clamp(speedScore, -10, 10),
              weight:   0.04,
              label:    'GEX Speed (Cliff)',
              category: 'options_gex',
              detail:   `dGEX/dS=${(avgSpeed / 1e6).toFixed(0)}M/pt [${cliffLabel}]`,
            };
          }
        }
      }
    }
  }

  // ── Gamma concentration signal ───────────────────────────────────────────────
  if (gex?.concentration?.score != null) {
    const c = gex.concentration;
    signals.gammaConc = {
      score:    c.score,
      weight:   0.04,
      label:    'Gamma Concentration',
      category: 'options_gex',
      detail:   `${c.pct}% of |GEX| within ±1% spot [${c.label}]`,
    };
  }

  // ── GEX × Hurst regime gate ──────────────────────────────────────────────────
  // The single most impactful structural interaction in the system.
  // Positive GEX (vol-suppressing, dealer long gamma) creates a mechanical
  // mean-reverting environment — dealers buy dips and sell rips.
  // Negative GEX (vol-amplifying, dealer short gamma) creates a trending tape —
  // dealers must chase the market, amplifying directional moves.
  //
  // Hurst exponent independently measures the realized autocorrelation character
  // of the price series (H>0.55 = trending, H<0.45 = mean-reverting).
  //
  // When GEX and Hurst AGREE → amplify the dominant signal cluster.
  // When they DISAGREE → GEX takes precedence (structural) over Hurst (statistical).
  // This gate modifies regime.weightMultipliers in-place before HMM processing.
  {
    // CRITICAL: clone weightMultipliers before mutating to avoid permanently corrupting
    // the module-level WEIGHT_MULTIPLIERS constant in regime.js, which computeRegime
    // returns as a direct reference on early-return paths (when gexContext is null).
    regime.weightMultipliers = { ...regime.weightMultipliers };

    const isPositiveGEX = gex ? (gex.totals?.totGEX ?? 0) > 0 : null;
    const H = hurstR.H ?? 0.5;
    const hurstMR    = H < 0.45; // mean-reverting
    const hurstTrend = H > 0.55; // trending

    if (isPositiveGEX !== null) {
      if (isPositiveGEX && hurstMR) {
        // Both agree: strong MR environment → boost MR + vol signals, suppress momentum
        regime.weightMultipliers.trend      = (regime.weightMultipliers.trend      ?? 1) * 1.25;
        regime.weightMultipliers.volatility = (regime.weightMultipliers.volatility ?? 1) * 1.15;
        regime.weightMultipliers.momentum   = (regime.weightMultipliers.momentum   ?? 1) * 0.70;
      } else if (!isPositiveGEX && hurstTrend) {
        // Both agree: strong trending environment → boost momentum + trend, suppress MR
        regime.weightMultipliers.momentum   = (regime.weightMultipliers.momentum   ?? 1) * 1.40;
        regime.weightMultipliers.trend      = (regime.weightMultipliers.trend      ?? 1) * 1.20;
        regime.weightMultipliers.volatility = (regime.weightMultipliers.volatility ?? 1) * 0.85;
      } else if (isPositiveGEX && hurstTrend) {
        // Disagreement: GEX says pin but tape is trending → trust options structure
        // Moderate both: elevate GEX signals, dampen extremes
        regime.weightMultipliers.options_gex = (regime.weightMultipliers.options_gex ?? 1) * 1.20;
        regime.weightMultipliers.momentum    = (regime.weightMultipliers.momentum    ?? 1) * 0.85;
      } else if (!isPositiveGEX && hurstMR) {
        // Disagreement: GEX says trend but tape is mean-reverting
        // GEX wins: keep options_gex elevated, moderate the MR cluster
        regime.weightMultipliers.options_gex = (regime.weightMultipliers.options_gex ?? 1) * 1.20;
        regime.weightMultipliers.trend       = (regime.weightMultipliers.trend       ?? 1) * 0.85;
      }
      // Neutral cases (H ≈ 0.5 or isPositiveGEX unknown): no gate modification
    }
  }

  // ── Realized correlation regime adjustment ───────────────────────────────────
  // When sectors move in lockstep (high avg pairwise corr), a single macro factor
  // dominates — macro/regime signals are more reliable, breadth/sector signals less so.
  // When sectors diverge (low corr), cross-sectional signals carry more information.
  // Reference: Pollet & Wilson (2010) "Average Correlation and Stock Market Returns."
  {
    const corrMatrix = Object.keys(multiAsset).length >= 5
      ? computeCorrelationMatrix(multiAsset, 60)
      : null;
    const avgPairCorr = computeAvgPairCorr(corrMatrix);

    if (avgPairCorr != null) {
      if (avgPairCorr > 0.65) {
        // High correlation: single-factor macro risk dominates
        regime.weightMultipliers.macro   = (regime.weightMultipliers.macro   ?? 1) * 1.20;
        regime.weightMultipliers.trend   = (regime.weightMultipliers.trend   ?? 1) * 0.85;
      } else if (avgPairCorr < 0.35) {
        // Low correlation: breadth and sector signals more informative
        regime.weightMultipliers.macro   = (regime.weightMultipliers.macro   ?? 1) * 0.85;
        regime.weightMultipliers.trend   = (regime.weightMultipliers.trend   ?? 1) * 1.15;
        regime.weightMultipliers.momentum = (regime.weightMultipliers.momentum ?? 1) * 1.10;
      }
    }
  }

  // HMM regime: use EXPECTED VALUE across all state probabilities instead of
  // the winning state's fixed score. The old approach always returned 0 when
  // HIGH_VOL_CHOP won (state 1 score=0), wasting the largest single weight.
  // Expected value: E[score] = Σ prob[i] × regimeScore[i]
  // Also blend in the GEX overlay score (pinning vs trending environment).
  {
    const regimeScoreMap = { LOW_VOL_BULL: 5, HIGH_VOL_CHOP: 0, CRASH_BEAR: -6, RECOVERY: 3 };
    const allProbs = regime.allProbs ?? {};
    const evScore  = Object.entries(allProbs).reduce((s, [label, p]) =>
      s + p * (regimeScoreMap[label] ?? 0), 0
    );
    // GEX overlay tilt: pinning → slight bearish (fades/range), trending → directional
    const gexTilt = regime.gexOverlay ? ({
      'GEX_PINNING':       -1.0,  // fade the composite slightly in pin regime
      'GEX_SOFT_SUPPORT':  +0.5,
      'GEX_WEAK_BREAKOUT': +1.5,
      'GEX_TRENDING':      +2.0,
    }[regime.gexOverlay.environment] ?? 0) : 0;
    const regimeSignalScore = Math.max(-10, Math.min(10, evScore + gexTilt));
    signals.hmmRegime = {
      score:    regimeSignalScore,
      weight:   0.10,
      label:    'HMM Regime',
      category: 'macro',
      detail:   `${regime.regime} (${(regime.confidence*100).toFixed(0)}%) | ${regime.gexOverlay?.environment ?? ''}`,
    };
  }

  signals.hurst = { score: hurstR.score, weight: 0.06, label: 'Hurst Exponent', category: 'trend', detail: `H=${hurstR.H.toFixed(2)} ${hurstR.regime}` };

  // OU mean-reversion on VIX: always include when data available (not just when isMeanReverting).
  // Use atan soft-scaling on the z-score so it contributes proportionally at all levels.
  // VIX OU z > 0 means VIX above equilibrium → vol likely to mean-revert lower → bullish.
  // z < 0 means VIX below equilibrium → potential for vol expansion → bearish.
  if (ouVIX.zScore !== undefined) {
    const ouAtanScore = (2 / Math.PI) * Math.atan(-ouVIX.zScore / 1.5) * 10; // invert: high VIX z = bearish
    signals.ouZscore = {
      score:    ouAtanScore,
      weight:   0.07,
      label:    'OU VIX Mean-Rev',
      category: 'volatility',
      detail:   `z=${ouVIX.zScore.toFixed(2)} HL=${ouVIX.halfLife < 1e6 ? ouVIX.halfLife.toFixed(0)+'d' : '∞'}`,
    };
  }

  if (vrp) {
    signals.vrp = { score: vrp.score,                      weight: 0.07, label: 'Vol Risk Premium', category: 'volatility', detail: `VRP=${vrp.vrp.toFixed(1)}%` };
  }

  // ── Vanna-VRP Cross: dealer net vanna exposure × IV direction ──────────────
  // Source: "Dealerz" PDF — vanna (∂Δ/∂σ) drives dealer hedging flows as IV moves.
  // Key mechanic: if dealer net vanna > 0 (long vanna) and IV is RISING (VRP < 0,
  // realized > implied), dealers' delta increases → they must buy → bullish.
  // If IV FALLS (VRP > 0) with positive vanna → dealers sell → bearish.
  // This cross-signal is distinct from vexEvent (which only measures vanna magnitude).
  if (gex && vrp) {
    const netVanna = gex.totals.totVEX;   // proxy for net dealer vanna exposure
    // IV direction: negative VRP = realized > implied = vol expanding → dealers buy (if long vanna)
    //              positive VRP = implied > realized  = vol contracting → dealers sell (if long vanna)
    const ivDirSign = vrp.vrp > 0 ? -1 : +1;
    // Normalise vanna to [-10, +10]; scale cross by VRP magnitude (capped at 1×)
    const nvNorm   = (2 / Math.PI) * Math.atan(netVanna / 5e7) * 10;
    const vrpMag   = Math.min(Math.abs(vrp.vrp) / 5, 1.0);  // 5% VRP = full scale
    const rawScore = nvNorm * ivDirSign * vrpMag;
    signals.vannaVRP = {
      score:    clamp(rawScore, -10, 10),
      weight:   0.05,
      label:    'Vanna-VRP Flow',
      category: 'options_gex',
      detail:   `NVE=${netVanna > 0 ? '+' : ''}${(netVanna / 1e7).toFixed(0)}×10⁷ VRP=${vrp.vrp.toFixed(1)}% → ${ivDirSign > 0 ? 'VOL_EXP' : 'VOL_CRUSH'}`,
    };
  }

  signals.vixTermStruct = { score: vixTerm.score,          weight: 0.05, label: 'VIX Term Struct',  category: 'volatility', detail: vixTerm.regime };
  signals.tsmom         = { score: tsmom.tsmomScore,       weight: 0.08, label: 'TSMOM',            category: 'momentum',   detail: `conf=${(tsmom.confidence * 100).toFixed(0)}%` };

  if (crossAss) {
    signals.crossAsset = { score: crossAss.biasScore,      weight: 0.05, label: 'Cross-Asset Mom',  category: 'momentum',   detail: crossAss.regime };
  }

  signals.ofi          = { score: ofi.score,               weight: 0.06, label: 'Order Flow Imbal', category: 'momentum',   detail: ofi.interpretation };
  signals.intradayMom  = { score: intraday.score,          weight: 0.05, label: 'Intraday Momentum',category: 'momentum',   detail: intraday.type };
  signals.pdhPdl       = { score: pdh.score,               weight: 0.07, label: 'PDH/PDL Structure',category: 'trend',      detail: pdh.abovePDH ? 'ABOVE PDH' : pdh.belowPDL ? 'BELOW PDL' : 'IN RANGE' };
  signals.emaStack     = { score: emas.score,              weight: 0.04, label: 'EMA Stack',         category: 'trend',      detail: `${emas.score > 0 ? 'BULL' : 'BEAR'} STACK` };
  signals.vwapZscore   = { score: vwap.score,              weight: 0.05, label: 'VWAP Z-Score',     category: 'trend',      detail: `z=${vwap.zScore.toFixed(2)}` };

  // ── COT & Sentiment signals (when available) ───────────────────────────────
  if (cot.available) {
    if (cot.stale) {
      // COT data older than 10 days — flag the issue but still include at half weight
      // so it doesn't silently disappear while still polluting the composite at full weight.
      dataQualityIssues.push(`COT data ${cot.ageDays}d old (last: ${cot.lastDate})`);
    }
    const cotScore  = cot.compositeScore ?? cot.score;
    const cotWeight = isFutures ? 0.09 : 0.06;
    signals.cot = {
      score:    cotScore,
      weight:   cot.stale ? cotWeight * 0.5 : cotWeight,
      label:    'COT Positioning (TFF)',
      category: 'macro',
      detail:   `${cot.label} idx=${cot.cotIndex?.toFixed(0)} levNet=${(cot.netSpec/1000).toFixed(0)}K AM=${((cot.netAM ?? 0)/1000).toFixed(0)}K${cot.stale ? ' ⚠STALE' : ''}`,
    };
  }
  const aaii = sentiment.aaii;
  if (aaii?.available) {
    signals.aaiiSentiment = {
      score:    aaii.score,
      weight:   0.05,
      label:    'AAII Sentiment',
      category: 'macro',
      detail:   aaii.label ?? `Bull ${aaii.bullish?.toFixed(0)}% Bear ${aaii.bearish?.toFixed(0)}%`,
    };
  }
  // FINRA RegSHO: free tier only covers OTC securities, not listed ETFs/stocks.
  // Put/Call Ratio (computed from options chain above) is the better proxy for listed securities.
  const cnnFG = sentiment.cnn;
  if (cnnFG?.available) {
    signals.cnnFG = {
      score:    cnnFG.scoreVal ?? 0,
      weight:   0.04,
      label:    'CNN Fear & Greed',
      category: 'macro',
      detail:   `${cnnFG.rating ?? ''} (${cnnFG.score?.toFixed(0)})`,
    };
  }

  // ── Sector Breadth + Credit Spread (when data available) ──────────────────
  if (sectorBreadth?.available) {
    signals.breadth = {
      score:    sectorBreadth.score,
      weight:   0.07,
      label:    'Sector Breadth',
      category: 'trend',
      detail:   sectorBreadth.interpretation,
    };
  }
  if (creditSpreadSig?.available) {
    signals.creditSpread = {
      score:    creditSpreadSig.score,
      weight:   0.05,
      label:    'Credit Spread HYG/IEI',
      category: 'macro',
      detail:   creditSpreadSig.detail,
    };
  }

  // ── Fair Value Gaps + Overnight Gap ───────────────────────────────────────
  // FVG weight elevated for futures (ICT concept is most actionable on ES/NQ)
  const fvgWeight  = isFutures ? 0.07 : 0.04;
  const gapWeight  = isFutures ? 0.07 : 0.04;

  if (Math.abs(fvgResult.score) > 0) {
    signals.fvg = {
      score:    fvgResult.score,
      weight:   fvgWeight,
      label:    'Fair Value Gaps',
      category: 'trend',
      detail:   `${fvgResult.interpretation.replace(/_/g,' ')} · ${fvgResult.activeCount} active`,
    };
  }

  signals.overnightGap = {
    score:    overnight.score,
    weight:   gapWeight,
    label:    isFutures ? 'Globex Gap' : 'Overnight Gap',
    category: 'momentum',
    detail:   `${overnight.type.replace(/_/g,' ')} ${overnight.gapPct >= 0 ? '+' : ''}${overnight.gapPct?.toFixed(2)}%`,
  };

  // ── Advanced signals ───────────────────────────────────────────────────────
  // ORB (Opening Range Breakout): elevated weight for futures — critical intraday level.
  // For futures, the ORB is computed on proxy ETF (SPY/QQQ) 5m bars.  We scale the
  // displayed prices to the futures price space for readability in the detail label.
  if (adv.orb.available) {
    const orbScaled = (v) => isFutures ? Math.round(v * gexScale * 4) / 4 : v;
    const orbHiDisp = orbScaled(adv.orb.orbHigh);
    const orbLoDisp = orbScaled(adv.orb.orbLow);
    const orbDetail  = adv.orb.detail.replace(
      /ORB [\d.]+[–-][\d.]+/u,
      `ORB ${orbLoDisp.toFixed(isFutures ? 0 : 2)}–${orbHiDisp.toFixed(isFutures ? 0 : 2)}`
    );
    signals.orb = {
      score:    adv.orb.score,
      weight:   isFutures ? 0.08 : 0.05,
      label:    'Opening Range Breakout',
      category: 'momentum',
      detail:   orbDetail,
    };
  }

  // Standard Error Channel: trend + mean-reversion composite
  if (adv.seChannel.available) {
    signals.seChannel = {
      score:    adv.seChannel.score,
      weight:   0.06,
      label:    'SE Channel (LinReg)',
      category: 'trend',
      detail:   adv.seChannel.detail,
    };
  }

  // GARCH(1,1): volatility expansion/contraction signal
  if (adv.garch.available) {
    signals.garch = {
      score:    adv.garch.score,
      weight:   0.05,
      label:    'GARCH Vol Clustering',
      category: 'volatility',
      detail:   adv.garch.detail,
    };
  }

  // Entropy: chaos/order measure (low weight — more of a regime adjuster)
  if (adv.entropy.available) {
    signals.entropy = {
      score:    adv.entropy.score,
      weight:   0.04,
      label:    'Market Entropy',
      category: 'volatility',
      detail:   adv.entropy.detail,
    };
  }

  // Z-Score Mean Reversion: rolling price z-score (complement to OU)
  if (adv.zScoreMR.available) {
    signals.zScoreMR = {
      score:    adv.zScoreMR.score,
      weight:   0.05,
      label:    'Z-Score Mean-Rev',
      category: 'trend',
      detail:   adv.zScoreMR.detail,
    };
  }

  // VPA Divergence: Wyckoff volume-price analysis
  if (adv.vpa.available) {
    signals.vpa = {
      score:    adv.vpa.score,
      weight:   0.05,
      label:    'VPA (Wyckoff Vol)',
      category: 'momentum',
      detail:   adv.vpa.detail,
    };
  }

  // Intraday Seasonality: time-of-day bias (always available)
  signals.seasonality = {
    score:    adv.seasonality.score,
    weight:   0.04,
    label:    'Intraday Seasonality',
    category: 'momentum',
    detail:   adv.seasonality.detail,
  };

  // MRSM (Hamilton 1989): 2-state regime switching on returns
  if (adv.mrsm.available) {
    signals.mrsm = {
      score:    adv.mrsm.score,
      weight:   0.06,
      label:    'MRSM (Hamilton)',
      category: 'macro',
      detail:   adv.mrsm.detail,
    };
  }

  // Post-News Behavior: economic calendar proximity (low weight, heuristic)
  if (adv.postNews.available && Math.abs(adv.postNews.score) > 0) {
    signals.postNews = {
      score:    adv.postNews.score,
      weight:   0.03,
      label:    'Post-News Behavior',
      category: 'momentum',
      detail:   adv.postNews.detail,
    };
  }

  // ── Distribution shape signals ─────────────────────────────────────────────
  // Skewness & Kurtosis: return distribution shape — directional with tail amplifier
  if (adv.skewKurt.available) {
    signals.skewKurt = {
      score:    adv.skewKurt.score,
      weight:   0.05,
      label:    'Skew / Kurtosis',
      category: 'volatility',
      detail:   adv.skewKurt.detail,
    };
  }

  // Fat Tails: empirical vs Gaussian tail comparison, tail ratio directionality
  if (adv.fatTails.available) {
    signals.fatTails = {
      score:    adv.fatTails.score,
      weight:   0.04,
      label:    'Fat Tails (EVT)',
      category: 'volatility',
      detail:   adv.fatTails.detail,
    };
  }

  // Non-Normal Distribution: Gaussian mixture stress weight + KS normality test
  if (adv.nonNormal.available) {
    signals.nonNormal = {
      score:    adv.nonNormal.score,
      weight:   0.04,
      label:    'Non-Normal Dist',
      category: 'volatility',
      detail:   adv.nonNormal.detail,
    };
  }

  // CLT Convergence: Berry-Esseen bound + empirical tail mean-reversion
  // Only fires when last bar is in an extreme tail (score != 0)
  if (adv.clt.available && Math.abs(adv.clt.score) > 0.5) {
    signals.clt = {
      score:    adv.clt.score,
      weight:   0.04,
      label:    'CLT Tail MR',
      category: 'trend',
      detail:   adv.clt.detail,
    };
  }

  // ── IV Skew Slope: OLS regression of IV across ±15% moneyness strikes ─────
  // Measures the gradient of the vol smile/smirk using all near-expiry options.
  // Distinct from rr25d (two-point 25Δ estimate) — captures the full curvature.
  // Source: "Implied Volatility Surface" + "impliedvolatility.donotshare"
  if (adv.ivSkewSlope.available) {
    signals.ivSkewSlope = {
      score:    adv.ivSkewSlope.score,
      weight:   0.04,
      label:    'IV Skew Slope',
      category: 'options_gex',
      detail:   adv.ivSkewSlope.detail,
    };
  }

  // ── Straddle Expected Move vs Realized Move ────────────────────────────────
  // ATM straddle price = market's priced expected daily range.
  // ratio > 1.2 → already broke out → exhaustion / mean-reversion likely.
  // ratio < 0.35 → extreme pinning → gamma suppression continuation.
  // Source: "GAMMA_Methodology" + "Putting_volatility_to_work"
  // Gate: only fire when ratio is outside the normal 0.35–1.2 band (score != 0).
  // Silent in normal conditions — avoids diluting the composite with a neutral 0-score entry.
  if (adv.straddleMvmt.available && Math.abs(adv.straddleMvmt.score) > 0) {
    signals.straddleMvmt = {
      score:    adv.straddleMvmt.score,
      weight:   0.04,
      label:    'Straddle Move Ratio',
      category: 'volatility',
      detail:   adv.straddleMvmt.detail,
    };
  }

  // ── Variance Ratio Test (Lo-MacKinlay 1988) ───────────────────────────────
  // VR(4) > 1 → positive serial correlation → momentum environment
  // VR(4) < 1 → negative serial correlation → mean-reversion environment
  // z-statistic provides statistical confidence in the VR reading.
  // Complements Hurst (long-range) and MRSM (Markov regime switching)
  // by detecting short-horizon (4-day) autocorrelation structure.
  // Gate: only fire when the VR z-stat indicates a statistically meaningful departure
  // from random walk (|z| maps to |score| > ~1.5).  Pure random walk VR ≈ 1 is
  // genuinely uninformative and should not dilute the composite.
  if (adv.varRatio.available && Math.abs(adv.varRatio.score) > 1.5) {
    signals.varRatio = {
      score:    adv.varRatio.score,
      weight:   isFutures ? 0.06 : 0.05,
      label:    'Variance Ratio (VR4)',
      category: 'trend',
      detail:   adv.varRatio.detail,
    };
  }

  // ── Vol Surface Butterfly: IV curvature / kurtosis risk premium ───────────
  // Wing IV premium over ATM IV = market-priced fat-tail expectation.
  // High butterfly = more tail risk priced = larger expected kurtosis = bearish for MR.
  // Extreme butterfly (capitulation level) = contrarian bullish.
  // Source: Carr & Madan (2001) variance decomposition; Bergomi "Stoch Vol" Ch.2.
  if (adv.volButterfly.available) {
    signals.volButterfly = {
      score:    adv.volButterfly.score,
      weight:   0.04,
      label:    'Vol Surface Butterfly',
      category: 'volatility',
      detail:   adv.volButterfly.detail,
    };
  }

  // ── CVD Divergence: cumulative volume delta vs price direction ────────────
  // Divergence = sellers driving a rally (bearish) or buyers absorbing a drop (bullish).
  // Uses 5m intraday bars; falls back gracefully when bars5m is unavailable.
  // Source: Wyckoff (1910); practitioner order-flow analysis.
  if (adv.cvdDiverg.available) {
    signals.cvdDiverg = {
      score:    adv.cvdDiverg.score,
      weight:   adv.cvdDiverg.isDivergence ? 0.06 : 0.03,  // higher weight on divergence
      label:    'CVD Divergence',
      category: 'momentum',
      detail:   adv.cvdDiverg.detail,
    };
  }

  // ── Amihud Illiquidity Z-Score ────────────────────────────────────────────
  // Anomalously high |return|/volume = thin book = large price impact = vol expansion.
  // z-scored against recent history for instrument-agnostic scaling.
  // Source: Amihud (2002) JFM.
  if (adv.amihud.available) {
    signals.amihud = {
      score:    adv.amihud.score,
      weight:   0.04,
      label:    'Amihud Illiquidity',
      category: 'volatility',
      detail:   adv.amihud.detail,
    };
  }

  // ── Delta-Weighted Put/Call Ratio (DPCR) ─────────────────────────────────
  // Delta-weights each contract by |Δ| × OI: deep ITM hedges count more than
  // cheap OTM lotto tickets that dominate the raw P/C count.
  // High DPCR = structural put hedging = contrarian bullish.
  // Source: Bollen & Whaley (2004) Journal of Finance.
  if (adv.dpcr.available) {
    signals.dpcr = {
      score:    adv.dpcr.score,
      weight:   0.05,
      label:    'Delta-Wtd P/C (DPCR)',
      category: 'options_gex',
      detail:   adv.dpcr.detail,
    };
  }

  // ── NEW BATCH-2 SIGNALS ───────────────────────────────────────────────────

  // Downside Realized Semivariance (Barndorff-Nielsen 2010 / Patton-Sheppard 2015)
  if (adv.downsideSV.available) {
    signals.downsideSV = {
      score:    adv.downsideSV.score,
      weight:   0.05,
      label:    'Downside Semivariance',
      category: 'volatility',
      detail:   adv.downsideSV.detail,
    };
  }

  // VPIN — Volume-Synchronized Probability of Informed Trading (Easley et al. 2012)
  if (adv.vpin.available) {
    signals.vpin = {
      score:    adv.vpin.score,
      weight:   0.04,
      label:    'VPIN (Order Toxicity)',
      category: 'volatility',
      detail:   adv.vpin.detail,
    };
  }

  // Signed Option Net-Buying Pressure (Bollen-Whaley 2004 / Garleanu et al. 2009)
  if (adv.signedFlow.available) {
    signals.signedFlow = {
      score:    adv.signedFlow.score,
      weight:   0.05,
      label:    'Signed Option Flow',
      category: 'options_gex',
      detail:   adv.signedFlow.detail,
    };
  }

  // Skew Delta — change in IV skew (Cremers-Weinbaum 2010 / Xing-Zhang-Zhao 2010)
  if (adv.skewDelta.available) {
    signals.skewDelta = {
      score:    adv.skewDelta.score,
      weight:   0.05,
      label:    'Skew Delta (ΔRR)',
      category: 'options_gex',
      detail:   adv.skewDelta.detail,
    };
  }

  // OPEX Cycle (Ni-Pearson-Poteshman 2005 / quad-witch mechanics)
  // Always wire when available (score is often 0 = no OPEX pressure, which is fine)
  if (adv.opexCycle.available && Math.abs(adv.opexCycle.score) > 0) {
    signals.opexCycle = {
      score:    adv.opexCycle.score,
      weight:   0.04,
      label:    'OPEX Cycle',
      category: 'options_gex',
      detail:   adv.opexCycle.detail,
    };
  }

  // Pre-Event Drift — FOMC/CPI/NFP/TOM (Lucca-Moench 2015 / Ogden 1990)
  if (adv.preEventDrift.available) {
    signals.preEventDrift = {
      score:    adv.preEventDrift.score,
      weight:   isFutures ? 0.06 : 0.04,
      label:    'Pre-Event Drift',
      category: 'momentum',
      detail:   adv.preEventDrift.detail,
    };
  }

  // VRP Term Structure (Park 2015 / CBOE VVIX)
  if (adv.vrpTermStruct.available) {
    signals.vrpTermStruct = {
      score:    adv.vrpTermStruct.score,
      weight:   0.05,
      label:    'VRP Term Structure',
      category: 'volatility',
      detail:   adv.vrpTermStruct.detail,
    };
  }

  // Yield Curve + MOVE Index
  if (adv.yieldCurve.available) {
    signals.yieldCurve = {
      score:    adv.yieldCurve.score,
      weight:   0.05,
      label:    'Yield Curve (T10Y2Y)',
      category: 'macro',
      detail:   adv.yieldCurve.detail,
    };
  }

  // Cross-Asset Lead-Lag (Hou 2007 / credit leads equities)
  if (adv.leadLag.available) {
    signals.leadLag = {
      score:    adv.leadLag.score,
      weight:   0.05,
      label:    'Credit/Bond Lead-Lag',
      category: 'momentum',
      detail:   adv.leadLag.detail,
    };
  }

  // Relative Strength NQ/ES + small-cap breadth
  if (adv.relStrength.available) {
    signals.relStrength = {
      score:    adv.relStrength.score,
      weight:   isFutures ? 0.06 : 0.04,
      label:    'NQ/ES Relative Strength',
      category: 'momentum',
      detail:   adv.relStrength.detail,
    };
  }

  // 0DTE GEX (CBOE 2023: >50% of SPX volume; pin/puke mechanics)
  if (adv.zeroDteGex.available) {
    signals.zeroDteGex = {
      score:    adv.zeroDteGex.score,
      weight:   isFutures ? 0.06 : 0.04,
      label:    '0DTE GEX',
      category: 'options_gex',
      detail:   adv.zeroDteGex.detail,
    };
  }

  // CLT Gaussian validity: scale down z-score and OU signals when CLT is poor
  // (Gaussian tools are unreliable when Berry-Esseen bound is high)
  if (adv.clt.available && adv.clt.gaussianValidityMultiplier < 0.95) {
    const gvm = adv.clt.gaussianValidityMultiplier;
    for (const key of ['zScoreMR', 'vwapZscore', 'ouZscore']) {
      if (signals[key]) signals[key].weight *= gvm;
    }
  }

  // ── Regime-conditional signal blacklisting ────────────────────────────────
  // In certain HMM regimes, specific signal classes produce noise rather than
  // signal. Hard-zeroing (deleting) them is more correct than soft-scaling:
  // a mean-reversion z-score in a crash is not a "weaker" signal — it's wrong.
  //
  // CRASH_BEAR: MR signals and structural signals are unreliable;
  //             volatility and macro signals should dominate.
  // LOW_VOL_BULL: vol-regime signals are less informative; trend/momentum lead.
  const regimeConfidence = regime.confidence ?? 0;
  if (regime.regime === 'CRASH_BEAR' && regimeConfidence > 0.60) {
    // Delete mean-reversion and structure signals — they're noise in a crash
    for (const key of ['zScoreMR', 'vwapZscore', 'clt', 'seChannel', 'pdhPdl', 'fvg', 'orb']) {
      delete signals[key];
    }
    // Remove OPEX cycle (structural flows overwhelmed in panic)
    delete signals.opexCycle;
    // Pre-event drift: the Lucca-Moench pre-FOMC anomaly persists even in crash regimes
    // (it's a mechanical institutional flow, not a sentiment effect).
    // Only remove if NOT in the active pre-FOMC or immediate post-FOMC window.
    if (!cal.inPreFomcWindow && !cal.inPostFomcCrush) {
      delete signals.preEventDrift;
    }
  }
  if (regime.regime === 'LOW_VOL_BULL' && regimeConfidence > 0.70) {
    // Vol-regime signals less relevant in calm trending bull; reduce their weights
    for (const key of ['garch', 'fatTails', 'entropy', 'nonNormal']) {
      if (signals[key]) signals[key].weight *= 0.45;
    }
  }

  // ── Cluster-aware weight normalization ────────────────────────────────────
  // SEQUENCING (important): cluster cap is applied to RAW weights FIRST,
  // then regime multipliers scale the capped weights.
  //
  // Why this order matters: applying regime mults BEFORE the cap would let
  // a boosted cluster (×1.4) pile signals at the cap value while a suppressed
  // cluster (×0.7) drops below the cap, making the cap asymmetric — it eats
  // upside boosts but passes downside cuts unchanged. Capping raw weights first
  // ensures regime mults express both boosts and suppressions symmetrically.
  //
  // Signals within the same correlation cluster share a total budget to prevent
  // double-counting: 4 mean-reversion signals won't get 4× the voice of 1.
  // Inspired by: Ang (2014) "Asset Management" Chapter 6 (risk-budget allocation).
  //
  // Note: signals in multiple clusters (rare) get the most restrictive cap applied.
  const CLUSTER_BUDGETS = {
    // Options: GEX structure (dealer positioning levels)
    gexStructure:   { keys: ['gexRegime', 'gammaFlipBias', 'gammaZone', 'gammaConc'],         budget: 0.12 },
    // Options: directional exposure (DEX is delta, not a vol/time greek — separate cluster)
    dexBiasCluster: { keys: ['dexBias'],                                                               budget: 0.07 },
    // Options: Greek flows (dealer hedging mechanics — vol/time greeks only)
    gexGreeks:      { keys: ['vexEvent', 'chexExpiry', 'charmIntraday', 'vannaVRP', 'zeroDteGex'],     budget: 0.09 },
    // Options: skew and flow
    volSkew:        { keys: ['rr25d', 'ivSkewSlope', 'volButterfly', 'skewDelta', 'putCall', 'signedFlow'], budget: 0.09 },
    // Options: single-signal clusters (isolated from above)
    gexSpeedCluster: { keys: ['gexSpeed'],                                                    budget: 0.03 },
    dpcrCluster:    { keys: ['dpcr'],                                                          budget: 0.04 },
    opexCluster:    { keys: ['opexCycle'],                                                     budget: 0.03 },
    // Volatility: VRP and term structure (collinear group)
    volRV:          { keys: ['vrp', 'garch', 'vixTermStruct', 'vrpTermStruct'],               budget: 0.07 },
    // Volatility: tail-risk / distribution shape (correlated)
    tailRisk:       { keys: ['skewKurt', 'fatTails', 'nonNormal', 'entropy'],                  budget: 0.05 },
    // Volatility: microstructure risk (correlated: all measure liquidity/toxicity)
    microstructure: { keys: ['amihud', 'vpin', 'downsideSV'],                                 budget: 0.05 },
    // Trend: mean-reversion cluster (highly collinear group)
    meanReversion:  { keys: ['ouZscore', 'zScoreMR', 'vwapZscore', 'clt'],                   budget: 0.07 },
    // Trend: directional structure (correlated: all measure trend state)
    trendStruct:    { keys: ['hurst', 'emaStack', 'seChannel', 'varRatio'],                   budget: 0.08 },
    // Trend: intraday structure levels (correlated: all measure intraday support/resistance)
    intradayStruct: { keys: ['pdhPdl', 'fvg', 'overnightGap', 'orb'],                        budget: 0.07 },
    // Momentum: time-series / cross-sectional momentum (correlated)
    momentum:       { keys: ['tsmom', 'intradayMom', 'crossAsset', 'relStrength'],            budget: 0.09 },
    // Momentum: order flow (correlated: all measure intraday buy/sell pressure)
    // leadLag is a DAILY cross-asset signal — wrong cluster if placed here.
    orderFlow:      { keys: ['ofi', 'cvdDiverg', 'vpa'],                                     budget: 0.06 },
    // Cross-asset daily lead: separate cluster so it gets its intended weight
    leadLagCluster: { keys: ['leadLag'],                                                      budget: 0.05 },
    // Calendar: event and seasonal signals
    calendar:       { keys: ['preEventDrift', 'seasonality', 'postNews'],                     budget: 0.04 },
    // Macro: regime classification (correlated: both are HMM-based)
    regimeClass:    { keys: ['hmmRegime', 'mrsm'],                                            budget: 0.08 },
    // Macro: fundamental / external data
    macroFund:      { keys: ['cot', 'yieldCurve', 'breadth', 'creditSpread'],                budget: 0.07 },
    // Macro: sentiment (correlated: both are retail/fear gauges)
    sentiment:      { keys: ['aaiiSentiment', 'cnnFG'],                                       budget: 0.03 },
    // Single-signal volatility
    straddleCluster: { keys: ['straddleMvmt'],                                                 budget: 0.05 },
  };

  // Step 1: Apply cluster cap to each signal's RAW weight
  for (const { keys, budget } of Object.values(CLUSTER_BUDGETS)) {
    const presentKeys = keys.filter(k => signals[k] !== undefined);
    if (presentKeys.length === 0) continue;
    const perSignalBudget = budget / presentKeys.length;
    for (const key of presentKeys) {
      // Only cap down — never inflate a signal that already has a smaller raw weight
      if (signals[key].weight > perSignalBudget) {
        signals[key].weight = perSignalBudget; // mutate raw weight (used in Step 2)
      }
    }
  }

  // Step 2: Apply regime multipliers to cluster-capped weights
  // (GEX×Hurst gate already modified regime.weightMultipliers above)
  const mults = regime.weightMultipliers;
  for (const [key, sig] of Object.entries(signals)) {
    const cat = sig.category ?? SIGNAL_CATEGORIES[key] ?? 'macro';
    sig.adjustedWeight = sig.weight * (mults[cat] ?? 1.0);
  }

  // Normalize all adjusted weights to sum to 1.0
  const totalWeight = Object.values(signals).reduce((s, sig) => s + sig.adjustedWeight, 0);
  for (const sig of Object.values(signals)) {
    sig.normalizedWeight = sig.adjustedWeight / (totalWeight || 1);
  }

  // ── Weighted composite ────────────────────────────────────────────────────
  // rawComposite: weighted average of signal scores, naturally in [-10, +10]
  // Soft-scale via atan: prevents hard-clamp at ±100 when all signals agree.
  // Maps rawComposite=4 → ±58, =6 → ±72, =8 → ±80, =10 → ±85 (extreme but not 100)
  const rawComposite = Object.values(signals).reduce((s, sig) => s + sig.score * sig.normalizedWeight, 0);
  const composite    = Math.round((2 / Math.PI) * Math.atan(rawComposite / 5) * 100);

  // ── Bootstrap Signal Agreement ────────────────────────────────────────────
  // Measures internal coherence: how sensitive the composite is to signal dropout.
  // Uses normalizedWeight so regime multipliers are reflected in the perturbation.
  // NOT a predictive confidence interval — does not measure out-of-sample accuracy.
  const { ciLow, ciHigh, confidence: rawSignalAgreement } = bootstrapCI(signals, 1000);

  // Entropy confidence multiplier: in chaotic markets (high entropy), shrink
  // effective confidence so Kelly bet is smaller and CI is wider.
  // ECM ∈ [0.55, 1.0] — pure random data → 0.55, orderly/trending → 1.0.
  // This is the correct place to apply it (not on normalized weights, where it cancels).
  const ecm = adv.entropy.available ? adv.entropy.signalConfidenceMultiplier : 1.0;
  const signalAgreement = clamp(rawSignalAgreement * ecm, 0.40, 0.95);
  // "confidence" kept as alias for backwards compatibility with API consumers
  const confidence = signalAgreement;

  // ── Event risk Kelly reducer ──────────────────────────────────────────────
  // Within 24h of FOMC, CPI, or NFP: IV is elevated, realized vol will spike post-release.
  // Effective risk per unit of position is significantly higher than a random day.
  // Halve the Kelly fraction independently of the VIX scalar (which only adjusts for
  // current vol level, not the expected vol jump at a known event).
  const inHighImpactWindow = cal.inPreFomcWindow || cal.inPostFomcCrush ||
                             cal.inPreCpiWindow  || cal.inPostCpiCrush  || cal.inPreNFPWindow;
  const kellyFraction = inHighImpactWindow ? 0.25 : 0.50;

  // ── Kelly sizing ──────────────────────────────────────────────────────────
  const kelly = biasAdjustedKelly(composite, confidence, vixCur, kellyFraction);

  // ── Pillar scores (for bar chart) ────────────────────────────────────────
  const pillars = {};
  for (const [key, sig] of Object.entries(signals)) {
    const cat = sig.category ?? 'macro';
    if (!pillars[cat]) pillars[cat] = { totalScore: 0, totalWeight: 0, signals: [] };
    pillars[cat].totalScore  += sig.score * sig.normalizedWeight;
    pillars[cat].totalWeight += sig.normalizedWeight;
    pillars[cat].signals.push({ key, label: sig.label, score: sig.score, detail: sig.detail });
  }
  for (const cat of Object.values(pillars)) {
    cat.pillarScore = cat.totalWeight > 0 ? clamp(cat.totalScore / cat.totalWeight * 10, -10, 10) : 0;
  }

  // ── Key levels: GEX + PDH/PDL + FVG + Round Numbers ─────────────────────
  // For futures, GEX levels come from the proxy ETF (SPY/QQQ) and must be scaled
  // to the futures price domain (ES ≈ 10× SPY; NQ ≈ 20× QQQ approximately).
  // gexScale and proxySpot were hoisted above (needed earlier for signal labels).
  const scaleLevel = (price) => price ? Math.round(price * gexScale * 4) / 4 : null; // round to 0.25

  const gexLevels = gex ? [
    { type: 'GAMMA_FLIP', price: scaleLevel(gex.keyLevels.gammaFlip), label: `Gamma Flip${isFutures ? ' (ETF proxy)' : ''}` },
    { type: 'CALL_WALL',  price: scaleLevel(gex.keyLevels.callWall),  label: 'Call Wall'  },
    { type: 'PUT_WALL',   price: scaleLevel(gex.keyLevels.putWall),   label: 'Put Wall'   },
    { type: 'MAX_PAIN',   price: scaleLevel(gex.keyLevels.maxPain),   label: 'Max Pain'   },
  ] : [];

  const structLevels = [
    { type: 'PDH',  price: bars.at(-2)?.high, label: 'PDH' },
    { type: 'PDL',  price: bars.at(-2)?.low,  label: 'PDL' },
  ];

  // Nearest unmitigated FVG midpoints as key levels
  const fvgLevels = [
    fvgResult.nearestBullFVG && { type: 'BULL_FVG', price: fvgResult.nearestBullFVG.mid,
      label: `Bull FVG (${fvgResult.nearestBullFVG.lo?.toFixed(1)}–${fvgResult.nearestBullFVG.hi?.toFixed(1)})` },
    fvgResult.nearestBearFVG && { type: 'BEAR_FVG', price: fvgResult.nearestBearFVG.mid,
      label: `Bear FVG (${fvgResult.nearestBearFVG.lo?.toFixed(1)}–${fvgResult.nearestBearFVG.hi?.toFixed(1)})` },
  ].filter(Boolean);

  const keyLevels = [
    ...gexLevels,
    ...structLevels,
    ...fvgLevels,
    ...roundLvls.map(l => ({ type: l.type, price: l.price, label: l.label })),
    // ORB levels (when 5m bars available): shown in the instrument's own price space.
    // For futures, the 5m bars come from the proxy ETF (SPY/QQQ), so we scale by gexScale.
    ...(adv.orb?.available ? [
      { type: 'ORB_HIGH', price: Math.round(adv.orb.orbHigh * gexScale * 4) / 4, label: 'ORB High' },
      { type: 'ORB_LOW',  price: Math.round(adv.orb.orbLow  * gexScale * 4) / 4, label: 'ORB Low'  },
    ] : []),
  ].filter(l => l.price > 0).sort((a, b) => b.price - a.price);

  // ── Session trading directive ─────────────────────────────────────────────
  // Translates the composite score + GEX environment + regime into a clear
  // actionable instruction for the trading session.
  // Logic:
  //   Positive GEX (dealers long gamma) → mean-reverting tape → "buy dips / sell rips"
  //   Negative GEX (dealers short gamma) → trending tape → "trend long / trend short"
  //   Chop regime or high entropy → "fade extremes" or "avoid"
  //   Crash bear → "sell every rip aggressively"
  const isPositiveGEX    = gex ? (gex.totals?.totGEX ?? 0) > 0 : true;
  const regimeName       = regime.regime ?? '';
  const regimeConf       = regime.confidence ?? 0;
  const isCrash          = regimeName === 'CRASH_BEAR';
  const isChop           = regimeName === 'HIGH_VOL_CHOP';
  const isRecovery       = regimeName === 'RECOVERY';
  const entropyHigh      = adv.entropy.available && adv.entropy.combined > 0.68;
  const abs              = Math.abs(composite);

  let directive, directiveColor, directiveReason;

  if (isCrash && regimeConf > 0.65) {
    // Crash bear with conviction: sell everything
    directive      = 'SELL EVERY RIP';
    directiveColor = 'bear';
    directiveReason = 'Crash-bear regime — no longs, sell into every bounce, tight covers';
  } else if (entropyHigh && abs < 30) {
    // Market is chaotic and score is ambiguous: stand aside
    directive      = 'AVOID';
    directiveColor = 'warn';
    directiveReason = 'High market entropy — signals conflicting, wait for clear setup';
  } else if (isChop && abs < 35 && !entropyHigh) {
    // High-vol chop: fade moves, no trend
    directive      = 'FADE EXTREMES';
    directiveColor = 'neutral';
    directiveReason = 'High-vol chop regime — fade rips and dips, small size, quick exits';
  } else if (composite >= 55) {
    // Strong bull
    directive      = isPositiveGEX ? 'BUY ALL DIPS' : 'TREND LONG';
    directiveColor = 'bull';
    directiveReason = isPositiveGEX
      ? 'Strong bull + positive GEX — dealers buy dips, follow them, hold winners'
      : 'Strong bull + negative GEX — trending tape, ride momentum, don\'t fade';
  } else if (composite <= -55) {
    // Strong bear
    directive      = isPositiveGEX ? 'SELL ALL RIPS' : 'TREND SHORT';
    directiveColor = 'bear';
    directiveReason = isPositiveGEX
      ? 'Strong bear + positive GEX — dealers sell rips, follow them, hold shorts'
      : 'Strong bear + negative GEX — trending tape down, don\'t fade, ride it';
  } else if (composite >= 25) {
    // Moderate bull
    directive      = 'BUY DIPS';
    directiveColor = 'bull';
    directiveReason = isPositiveGEX
      ? 'Bullish bias + GEX pin — dealers support dips, size up on pullbacks'
      : 'Bullish bias + trending tape — buy dips but size down, moves can extend';
  } else if (composite <= -25) {
    // Moderate bear
    directive      = 'SELL RIPS';
    directiveColor = 'bear';
    directiveReason = isPositiveGEX
      ? 'Bearish bias + GEX pin — dealers sell strength, fade bounces'
      : 'Bearish bias + trending tape — sell rips but size down, can accelerate';
  } else if (composite >= 10) {
    // Mild lean long
    directive      = 'LEAN LONG';
    directiveColor = 'bull';
    directiveReason = isRecovery
      ? 'Recovery regime — prefer long setups, reduce short exposure'
      : 'Mild bullish lean — prefer long entries, smaller size than usual';
  } else if (composite <= -10) {
    // Mild lean short
    directive      = 'LEAN SHORT';
    directiveColor = 'bear';
    directiveReason = 'Mild bearish lean — prefer short entries, avoid aggressive longs';
  } else {
    // No edge
    directive      = 'RANGE / FADE';
    directiveColor = 'neutral';
    directiveReason = 'No clear directional edge — fade extremes at key levels, very small size';
  }

  // ── Three timeframe sub-composites ───────────────────────────────────────
  // Computed AFTER normalizedWeight is set on all signals.
  // Each isolates only the signals relevant to that trading horizon,
  // re-normalises their weights within the group, and applies the same atan softening.
  const scalpBias   = subComposite(signals, 'scalp');
  const sessionBias = subComposite(signals, 'session');
  const macroBias   = subComposite(signals, 'macro');

  return {
    symbol,
    spot,
    composite: Math.round(composite),
    label: scoreToLabel(composite),
    confidence: Math.round(signalAgreement * 100) / 100,
    signalAgreement: Math.round(signalAgreement * 100) / 100,
    ciLow,
    ciHigh,
    eventRisk: inHighImpactWindow,
    kellyFraction,
    dataQuality: {
      degraded: dataQualityIssues.length > 0,
      issues:   dataQualityIssues,
      priceAgeMin:   priceAgeMs   ? Math.round(priceAgeMs   / 60000) : null,
      optionsAgeMin: optionsAgeMs ? Math.round(optionsAgeMs / 60000) : null,
      vixAgeMin:     vixAgeMs     ? Math.round(vixAgeMs     / 60000) : null,
    },
    // Session trading directive — actionable label for the session
    directive,
    directiveColor,
    directiveReason,
    // Three-horizon bias breakdown
    scalpBias,    // < 30 min: ORB, CVD, 0DTE, charm, order-flow
    sessionBias,  // full session: GEX levels, VRP, skew, PDH/PDL
    macroBias,    // days/weeks: regime, COT, TSMOM, breadth, yield curve
    signals,
    pillars,
    regime,
    hurst:  hurstR,
    vrp,
    vixTerm,
    gex:    gex ? {
      profile:    gex.profile,
      keyLevels:  gex.keyLevels,
      totals:     gex.totals,
      rr25d:      gex.rr25d,
      putCallRatio: gex.putCallRatio,
      proxySpot:  gex.spot,
      proxySymbol: isFutures ? (futProxy?.gexProxy ?? null) : null,
    } : null,
    keyLevels,
    roundLevels: roundLvls,
    kelly,
    tsmom,
    ofi,
    cot,
    sentiment,
    breadth:      sectorBreadth,
    creditSpread: creditSpreadSig,
    fvg:          fvgResult,
    overnightGap: overnight,
    advanced:     adv,
    isFutures,
    futuresProxy: futProxy,
    modulesFired: Object.values(signals).filter(s => Math.abs(s.score) > 1).length,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { calculateBias, scoreToLabel };
