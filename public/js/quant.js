'use strict';

let currentSymbol    = 'SPY';
let vixChartQ        = null;
let volProfileChartQ = null;
const $ = id => document.getElementById(id);
const fmt    = (v, d=2) => v != null ? Number(v).toFixed(d) : '—';
const fmtPct = v => v != null ? `${Number(v).toFixed(1)}%` : '—';
const pct    = v => v != null ? `${(v*100).toFixed(1)}%` : '—';
const sign   = (v, d=2) => v != null ? (v >= 0 ? `+${fmt(v,d)}` : fmt(v,d)) : '—';

function scoreColor(v) {
  if (v > 1)  return 'var(--bull)';
  if (v < -1) return 'var(--bear)';
  return 'var(--neutral)';
}

function setStatus(ok) {
  const dot = $('statusDot');
  if (dot) dot.className = ok ? 'status-dot live' : 'status-dot';
}

// ── Render HMM regime ─────────────────────────────────────────────────────────
function renderRegime(regime) {
  if (!regime) return;
  const colors = { LOW_VOL_BULL:'#34d399', HIGH_VOL_CHOP:'#fbbf24', CRASH_BEAR:'#fb7185', RECOVERY:'#60a5fa' };
  const color = colors[regime.regime] ?? '#71717a';

  const dot  = $('qRegimeDot');
  const name = $('qRegimeName');
  const conf = $('qRegimeConf');
  const bars = $('qRegimeBars');
  const wm   = $('qWeightMults');

  if (dot)  dot.style.background = color;
  if (name) { name.textContent = regime.regime?.replace(/_/g,' ') ?? '—'; name.style.color = color; }
  if (conf) conf.textContent = `Conf: ${(regime.confidence * 100).toFixed(0)}%`;

  if (bars && regime.allProbs) {
    bars.innerHTML = Object.entries(regime.allProbs).map(([state, prob]) => {
      const c = colors[state] ?? '#71717a';
      return `<div class="regime-bar-row">
        <span class="regime-bar-label">${state.replace(/_/g,' ')}</span>
        <div class="regime-bar-track"><div class="regime-bar-fill" style="width:${(prob*100).toFixed(1)}%;background:${c}"></div></div>
        <span class="regime-bar-pct">${(prob*100).toFixed(0)}%</span>
      </div>`;
    }).join('');
  }

  if (wm && regime.weightMultipliers) {
    const labels = { trend:'Trend', options_gex:'GEX', momentum:'Mom', volatility:'Vol', macro:'Macro' };
    wm.innerHTML = Object.entries(regime.weightMultipliers).map(([k, v]) => {
      const col = v > 1 ? 'var(--bull)' : v < 1 ? 'var(--bear)' : 'var(--muted)';
      return `<span style="font-size:9px;font-family:var(--mono);padding:3px 6px;background:var(--panel);border:0.5px solid var(--border);border-radius:3px;color:${col}">
        ${labels[k] ?? k}: ×${v.toFixed(1)}</span>`;
    }).join('');
  }
}

// ── Render Hurst ──────────────────────────────────────────────────────────────
function renderHurst(hurst) {
  if (!hurst) return;
  const H = hurst.H;
  const color = H > 0.6 ? 'var(--bull)' : H < 0.4 ? 'var(--bear)' : 'var(--neutral)';

  if ($('qHurstH'))       { $('qHurstH').textContent = H.toFixed(3); $('qHurstH').style.color = color; }
  if ($('qHurstRegime'))  { $('qHurstRegime').textContent = hurst.regime ?? '—'; $('qHurstRegime').style.color = color; }
  if ($('qH5d'))          $('qH5d').textContent  = hurst.H5d?.toFixed(3)  ?? '—';
  if ($('qH20d'))         $('qH20d').textContent = hurst.H20d?.toFixed(3) ?? '—';
  if ($('qH60d'))         $('qH60d').textContent = hurst.H60d?.toFixed(3) ?? '—';
  if ($('qMomValid'))     { $('qMomValid').textContent = hurst.momentumValidity?.toFixed(2) ?? '—'; $('qMomValid').style.color = hurst.momentumValidity > 0.5 ? 'var(--bull)' : 'var(--neutral)'; }
  if ($('qRevValid'))     { $('qRevValid').textContent = hurst.reversionValidity?.toFixed(2) ?? '—'; $('qRevValid').style.color = hurst.reversionValidity > 0.5 ? 'var(--bear)' : 'var(--neutral)'; }
  if ($('qHurstBias'))    { $('qHurstBias').textContent = hurst.bias_adjustment ?? hurst.biasAdjustment ?? '—'; }
}

// ── Render OU scores ──────────────────────────────────────────────────────────
function renderOUScores(ouSpreads) {
  const el = $('ouScoreList');
  if (!el || !ouSpreads) return;

  el.innerHTML = Object.entries(ouSpreads).map(([name, ou]) => {
    if (!ou) return '';
    const zColor = scoreColor(ou.zScore);
    const usable = ou.isMeanReverting;
    return `
      <div style="padding-bottom:10px;border-bottom:0.5px solid var(--border)">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:var(--text)">${name.toUpperCase()} Spread</span>
          <span style="font-size:9px;padding:2px 6px;border-radius:3px;font-weight:600;
            background:${usable ? 'var(--bull-dim)' : '#27272a'};
            color:${usable ? 'var(--bull)' : 'var(--muted)'}">${usable ? 'TRADEABLE' : 'LONG HL'}</span>
        </div>
        <table class="ou-table">
          <tr><td>Z-Score (Avellaneda s-score)</td>
              <td><span style="font-family:var(--mono);font-size:14px;font-weight:700;color:${zColor}">${ou.zScore?.toFixed(2) ?? '—'}</span></td></tr>
          <tr><td>Half-Life</td><td>${ou.halfLife?.toFixed(1) ?? '∞'} bars</td></tr>
          <tr><td>κ (reversion speed)</td><td>${ou.kappa?.toFixed(4) ?? '—'}</td></tr>
          <tr><td>μ (equilibrium)</td><td>${ou.mu?.toFixed(4) ?? '—'}</td></tr>
          <tr><td>Signal</td><td style="color:${scoreColor(ou.signal)}">${ou.signal === 1 ? 'BUY (mean reversion)' : ou.signal === -1 ? 'SELL (mean reversion)' : 'NEUTRAL'}</td></tr>
        </table>
      </div>`;
  }).join('');
}

// ── Render VRP ────────────────────────────────────────────────────────────────
function renderVRP(vrp, vixRaw) {
  if (!vrp) return;
  const color = vrp.vrp > 3 ? 'var(--bull)' : vrp.vrp < -2 ? 'var(--bear)' : 'var(--neutral)';

  if ($('qVRPval'))    { $('qVRPval').textContent = `${vrp.vrp?.toFixed(2)}%`; $('qVRPval').style.color = color; }
  if ($('qVRPinterp')) { $('qVRPinterp').textContent = vrp.interpretation ?? '—'; $('qVRPinterp').style.color = color; }
  if ($('qIV'))        $('qIV').textContent = fmtPct(vrp.iv);
  if ($('qRV'))        $('qRV').textContent = fmtPct(vrp.rv);
  if ($('qGK'))        $('qGK').textContent = vrp.gkVol ? fmtPct(vrp.gkVol) : '—';
  if ($('qVRPz'))      { $('qVRPz').textContent = vrp.vrpZscore?.toFixed(2) ?? '—'; $('qVRPz').style.color = color; }
  if ($('qVRPsig'))    { $('qVRPsig').textContent = vrp.signal === 1 ? 'MR/RANGE' : vrp.signal === -1 ? 'BREAKOUT' : 'NEUTRAL'; $('qVRPsig').style.color = color; }

  if (vixRaw) {
    if ($('qVIX9D'))  $('qVIX9D').textContent  = vixRaw.vix9d?.toFixed(1)  ?? '—';
    if ($('qVIX'))    $('qVIX').textContent    = vixRaw.vix?.toFixed(1)     ?? '—';
    if ($('qVIX3M'))  $('qVIX3M').textContent  = vixRaw.vix3m?.toFixed(1)   ?? '—';
    if ($('qVVIX'))   $('qVVIX').textContent   = vixRaw.vvix?.toFixed(1)    ?? '—';
    if ($('qSKEW'))   $('qSKEW').textContent   = vixRaw.skew?.toFixed(1)    ?? '—';
    if ($('qVixRatio')) $('qVixRatio').textContent = vixRaw.termRatio?.toFixed(3) ?? '—';

    const badge = $('qVixRegimeBadge');
    if (badge) {
      badge.textContent = vixRaw.contango ? 'CONTANGO' : 'BACKWARDATION';
      badge.className   = `stat-badge ${vixRaw.contango ? 'badge-bull' : 'badge-bear'}`;
    }
  }
}

// ── VIX chart ─────────────────────────────────────────────────────────────────
function renderVIXChart(series) {
  const canvas = $('qVixChart');
  if (!canvas || !series?.vix?.length) return;

  const labels = series.vix.map(d => d.date).slice(-90);
  const sl = d => (series[d] ?? []).slice(-90).map(p => p.close);

  if (vixChartQ) { vixChartQ.destroy(); vixChartQ = null; }

  vixChartQ = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'VIX9D', data: sl('vix9d'), borderColor:'#fb7185', borderWidth:1.5, pointRadius:0, tension:0.3 },
        { label:'VIX',   data: sl('vix'),   borderColor:'#e4e4e7', borderWidth:1.5, pointRadius:0, tension:0.3, fill:'origin', backgroundColor:'#27272a33' },
        { label:'VIX3M', data: sl('vix3m'), borderColor:'#60a5fa', borderWidth:1.5, pointRadius:0, tension:0.3 },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins: {
        legend:{ display:false },
        tooltip:{
          backgroundColor:'#111113', borderColor:'#27272a', borderWidth:1,
          titleColor:'#f4f4f5', bodyColor:'#71717a',
          titleFont:{ family:'Geist Mono', size:10 }, bodyFont:{ family:'Geist Mono', size:10 },
        },
      },
      scales:{
        x:{ grid:{ color:'#1a1a1d' }, ticks:{ color:'#52525b', font:{ family:'Geist Mono', size:9 }, maxTicksLimit:8, maxRotation:0,
          callback:(_, i, arr) => (i===0||i===arr.length-1||i%Math.floor(arr.length/6)===0) ? labels[i]?.slice(5) : null } },
        y:{ min:10, grid:{ color:'#1a1a1d' }, ticks:{ color:'#52525b', font:{ family:'Geist Mono', size:9 }, stepSize:5 } },
      },
    },
  });
}

// ── Fear & Greed ──────────────────────────────────────────────────────────────
function renderFearGreed(fg, macro) {
  if (!fg) return;
  const score = fg.score;
  const color = score < 25 ? 'var(--bull)' : score > 75 ? 'var(--bear)' : 'var(--neutral)';

  if ($('qFGScore'))  { $('qFGScore').textContent = score?.toFixed(0) ?? '—'; $('qFGScore').style.color = color; }
  if ($('qFGRating')) { $('qFGRating').textContent = fg.rating?.replace(/_/g,' ').toUpperCase() ?? '—'; $('qFGRating').style.color = color; }
  if ($('qFGChange')) $('qFGChange').textContent = `Prev 1D: ${fg.prev1d?.toFixed(0) ?? '—'} · Prev 1W: ${fg.prev1w?.toFixed(0) ?? '—'}`;

  if (macro) {
    if ($('qYieldSpread')) { const v = macro.yieldSpread?.value; $('qYieldSpread').textContent = v ? `${v.toFixed(2)}%` : '—'; $('qYieldSpread').style.color = v < 0 ? 'var(--bear)' : v > 0.5 ? 'var(--bull)' : 'var(--muted)'; }
    if ($('qFedRate'))    $('qFedRate').textContent  = macro.fedRate?.value  ? `${macro.fedRate.value.toFixed(2)}%`    : '—';
    if ($('qDXY'))        $('qDXY').textContent      = macro.dxy ? `$${macro.dxy.toFixed(2)}` : '—';
  }
}

// ── TSMOM ─────────────────────────────────────────────────────────────────────
function renderTSMOM(tsmom) {
  if (!tsmom) return;
  const color = tsmom.tsmomScore > 0 ? 'var(--bull)' : tsmom.tsmomScore < 0 ? 'var(--bear)' : 'var(--neutral)';

  if ($('qTSMOMScore')) { $('qTSMOMScore').textContent = `${tsmom.tsmomScore >= 0 ? '+' : ''}${tsmom.tsmomScore.toFixed(1)}`; $('qTSMOMScore').style.color = color; }
  if ($('qTSMOMConf'))  $('qTSMOMConf').textContent = `Confidence: ${(tsmom.confidence * 100).toFixed(0)}%`;
  if ($('qTSMOMAgree')) $('qTSMOMAgree').textContent = tsmom.allAgree ? 'All lookbacks agree' : 'Mixed lookback signals';

  const grid = $('qTSMOMGrid');
  if (grid && tsmom.signals) {
    grid.innerHTML = Object.values(tsmom.signals).map(s => {
      const ret    = s.rawReturn ?? 0;
      const retPct = (ret * 100).toFixed(2);
      const barW   = Math.min(Math.abs(ret) / 0.3 * 50, 50);
      const c      = ret >= 0 ? 'var(--bull)' : 'var(--bear)';
      return `<div class="tsmom-row">
        <span class="tsmom-period">${s.label ?? '?'}</span>
        <div class="tsmom-bar" style="background:var(--border)">
          <div class="tsmom-fill" style="width:${barW}%;left:${ret>=0?'50%':''}; right:${ret<0?'50%':''};background:${c}"></div>
        </div>
        <span class="tsmom-ret" style="color:${c}">${ret>=0?'+':''}${retPct}%</span>
      </div>`;
    }).join('');
  }
}

// ── Cross-asset ───────────────────────────────────────────────────────────────
function renderCrossAsset(ca) {
  if (!ca) return;
  const rosEl  = $('qRiskOnScore');
  const roffEl = $('qRiskOffScore');
  const regEl  = $('qCrossRegime');
  const grid   = $('qAssetGrid');

  if (rosEl)  { rosEl.textContent = ca.riskOnScore?.toFixed(1) ?? '—'; rosEl.style.color = scoreColor(ca.riskOnScore); }
  if (roffEl) { roffEl.textContent = ca.riskOffScore?.toFixed(1) ?? '—'; roffEl.style.color = scoreColor(-ca.riskOffScore); }
  if (regEl)  { regEl.textContent = ca.regime ?? '—'; regEl.style.color = ca.composite > 5 ? 'var(--bull)' : ca.composite < -5 ? 'var(--bear)' : 'var(--neutral)'; }

  if (grid && ca.tickerScores) {
    const riskOn  = ['SPY','QQQ','IWM','HYG','XLY','SMH'];
    const riskOff = ['TLT','GLD'];
    grid.innerHTML = [...riskOn, ...riskOff].map(t => {
      const sc = ca.tickerScores[t];
      if (sc == null) return '';
      const c = scoreColor(sc);
      return `<div class="asset-cell">
        <span class="asset-ticker" style="color:${riskOff.includes(t)?'var(--muted)':'var(--text)'}">${t}</span>
        <span class="asset-score" style="color:${c}">${sc>=0?'+':''}${sc.toFixed(1)}</span>
        <span class="asset-dir" style="color:${c}">${sc>2?'BULL':sc<-2?'BEAR':'NEUT'}</span>
      </div>`;
    }).join('');
  }
}

// ── OFI + Intraday ────────────────────────────────────────────────────────────
function renderOFI(ofi, intraday) {
  if (!ofi) return;
  const color = scoreColor(ofi.score);

  if ($('qOFIval'))    { $('qOFIval').textContent = ofi.ofi?.toFixed(3) ?? '—'; $('qOFIval').style.color = color; }
  if ($('qOFIz'))      { $('qOFIz').textContent = ofi.ofiZscore?.toFixed(2) ?? '—'; $('qOFIz').style.color = color; }
  if ($('qOFIinterp')) {
    $('qOFIinterp').textContent = ofi.interpretation ?? '—';
    $('qOFIinterp').style.background = ofi.score > 1 ? 'var(--bull-dim)' : ofi.score < -1 ? 'var(--bear-dim)' : '#27272a';
    $('qOFIinterp').style.color = ofi.score > 1 ? 'var(--bull)' : ofi.score < -1 ? 'var(--bear)' : 'var(--muted)';
  }

  if (intraday) {
    if ($('qIntradayType')) { $('qIntradayType').textContent = intraday.type ?? '—'; $('qIntradayType').style.color = scoreColor(intraday.score); }
    if ($('qGapRet'))       { const v = intraday.gapReturn; $('qGapRet').textContent = v ? `${(v*100).toFixed(2)}%` : '—'; $('qGapRet').style.color = v > 0 ? 'var(--bull)' : v < 0 ? 'var(--bear)' : 'var(--muted)'; }
    if ($('qIntradayRet'))  { const v = intraday.intradayReturn; $('qIntradayRet').textContent = v ? `${(v*100).toFixed(2)}%` : '—'; $('qIntradayRet').style.color = v > 0 ? 'var(--bull)' : v < 0 ? 'var(--bear)' : 'var(--muted)'; }
    if ($('qVolRatio'))     $('qVolRatio').textContent = intraday.volRatio?.toFixed(2) ?? '—';
  }
}

// ── Kelly ─────────────────────────────────────────────────────────────────────
function renderKelly(bias) {
  if (!bias?.kelly) return;
  const k = bias.kelly;
  const color = bias.composite >= 0 ? 'var(--bull)' : 'var(--bear)';

  if ($('qKellyRisk'))     { $('qKellyRisk').textContent = k.riskPct ?? '—'; $('qKellyRisk').style.color = color; }
  if ($('qKellyDir'))      { $('qKellyDir').textContent = k.direction ?? '—'; $('qKellyDir').style.color = color; }
  if ($('qKellyWP'))       $('qKellyWP').textContent = pct(k.winProbability);
  if ($('qKellyFull'))     $('qKellyFull').textContent = pct(k.fullKelly);
  if ($('qKellyHalf'))     $('qKellyHalf').textContent = pct(k.halfKelly);
  if ($('qKellyVS'))       $('qKellyVS').textContent = k.volScalar?.toFixed(2) ?? '—';
  if ($('qKellyRationale'))$('qKellyRationale').textContent = k.rationale ?? '—';
}

// ── Bootstrap CI ──────────────────────────────────────────────────────────────
function renderCI(bias) {
  if (!bias) return;
  const color = bias.composite >= 0 ? 'var(--bull)' : 'var(--bear)';

  if ($('qComposite'))  { $('qComposite').textContent = `${bias.composite >= 0?'+':''}${bias.composite}`; $('qComposite').style.color = color; }
  if ($('qConfidence')) $('qConfidence').textContent = `${Math.round((bias.confidence ?? 0)*100)}%`;
  if ($('qCI5'))        $('qCI5').textContent   = bias.ciLow  ?? '—';
  if ($('qCI95'))       $('qCI95').textContent  = bias.ciHigh ?? '—';
  if ($('qCIWidth'))    $('qCIWidth').textContent = bias.ciLow != null && bias.ciHigh != null ? `${bias.ciHigh - bias.ciLow} pts` : '—';
  if ($('qSigFired'))   $('qSigFired').textContent = `${bias.modulesFired ?? '—'} / ${Object.keys(bias.signals ?? {}).length}`;
  if ($('qBiasLabel'))  { $('qBiasLabel').textContent = bias.label ?? '—'; $('qBiasLabel').style.color = color; }
  if ($('qCILow'))      $('qCILow').textContent  = bias.ciLow  ?? '—';
  if ($('qCIHigh'))     $('qCIHigh').textContent = bias.ciHigh ?? '—';

  // CI bar visualization
  const bar = $('qCIBar');
  if (bar && bias.ciLow != null && bias.ciHigh != null) {
    const lo = (bias.ciLow  + 100) / 200; // normalize to 0-1
    const hi = (bias.ciHigh + 100) / 200;
    bar.style.left  = `${lo * 100}%`;
    bar.style.width = `${(hi - lo) * 100}%`;
    bar.style.background = color;
  }
}

// ── COT ───────────────────────────────────────────────────────────────────────
function renderCOT(cot) {
  if (!cot?.available) {
    if ($('qCOTIndex')) $('qCOTIndex').textContent = 'N/A';
    if ($('qCOTLabel')) $('qCOTLabel').textContent = cot?.error ?? 'Unavailable';
    return;
  }
  const color = cot.signal > 0 ? 'var(--bull)' : cot.signal < 0 ? 'var(--bear)' : 'var(--neutral)';

  if ($('qCOTIndex')) { $('qCOTIndex').textContent = cot.cotIndex?.toFixed(1) ?? '—'; $('qCOTIndex').style.color = color; }
  if ($('qCOTLabel')) { $('qCOTLabel').textContent = (cot.label ?? '—').replace(/_/g,' '); $('qCOTLabel').style.color = color; }
  if ($('qCOTNetSpec'))  $('qCOTNetSpec').textContent  = cot.netSpec?.toLocaleString()   ?? '—';
  if ($('qCOTNetComm'))  $('qCOTNetComm').textContent  = cot.netComm?.toLocaleString()   ?? '—';
  if ($('qCOTPosChange'))$('qCOTPosChange').textContent = cot.posChange != null ? (cot.posChange >= 0 ? '+' : '') + cot.posChange.toLocaleString() : '—';
  if ($('qCOTSignal'))   { $('qCOTSignal').textContent = `${cot.signal >= 0 ? '+' : ''}${cot.signal} (score ${cot.score?.toFixed(1)})`; $('qCOTSignal').style.color = color; }
  if ($('qCOTDate'))     $('qCOTDate').textContent = cot.lastDate ?? '—';

  // Recent rows mini table
  const tbody = $('qCOTRowsBody');
  if (tbody && cot.recentRows?.length) {
    tbody.innerHTML = cot.recentRows.slice(-8).reverse().map(r => `
      <tr>
        <td style="font-family:var(--mono)">${r.date}</td>
        <td style="font-family:var(--mono);color:${r.netSpec > 0 ? 'var(--bull)' : 'var(--bear)'}">${r.netSpec?.toLocaleString()}</td>
        <td style="font-family:var(--mono);color:${r.netComm > 0 ? 'var(--bull)' : 'var(--bear)'}">${r.netComm?.toLocaleString()}</td>
      </tr>`).join('');
  }
}

// ── Sentiment ─────────────────────────────────────────────────────────────────
function renderSentiment(sentiment) {
  if (!sentiment) return;

  // AAII
  const aaii = sentiment.aaii;
  if (aaii?.available) {
    const aColor = aaii.signal > 0 ? 'var(--bull)' : aaii.signal < 0 ? 'var(--bear)' : 'var(--neutral)';
    if ($('qAAIIBull'))    $('qAAIIBull').textContent    = aaii.bullish?.toFixed(1)  + '%' ?? '—';
    if ($('qAAIINeutral')) $('qAAIINeutral').textContent = aaii.neutral?.toFixed(1)  + '%' ?? '—';
    if ($('qAAIIBear'))    $('qAAIIBear').textContent    = aaii.bearish?.toFixed(1)  + '%' ?? '—';
    if ($('qAAIISpread'))  { $('qAAIISpread').textContent = (aaii.spread >= 0 ? '+' : '') + aaii.spread?.toFixed(1) + '%'; $('qAAIISpread').style.color = aaii.spread > 0 ? 'var(--bull)' : 'var(--bear)'; }
    if ($('qAAIISignal'))  { $('qAAIISignal').textContent = (aaii.label ?? '—').replace(/_/g,' '); $('qAAIISignal').style.color = aColor; }
  } else {
    if ($('qAAIISignal')) $('qAAIISignal').textContent = 'AAII unavailable — using F&G proxy';
  }

  // FINRA
  const finra = sentiment.finra;
  if (finra?.available) {
    const fColor = finra.signal > 0 ? 'var(--bull)' : finra.signal < 0 ? 'var(--bear)' : 'var(--neutral)';
    if ($('qFINRAShortRatio')) $('qFINRAShortRatio').textContent = (finra.shortRatio * 100)?.toFixed(1) + '%' ?? '—';
    if ($('qFINRAAvg5d'))      $('qFINRAAvg5d').textContent = (finra.avgShortRatio5d * 100)?.toFixed(1) + '%' ?? '—';
    if ($('qFINRAChg'))        { const v = finra.shortRatioPctChg; $('qFINRAChg').textContent = v != null ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%' : '—'; $('qFINRAChg').style.color = v > 0 ? 'var(--bear)' : 'var(--bull)'; }
    if ($('qFINRASignal'))     { $('qFINRASignal').textContent = (finra.label ?? '—').replace(/_/g,' '); $('qFINRASignal').style.color = fColor; }
  }

  // CNN F&G (from sentiment endpoint)
  const cnn = sentiment.cnn;
  if (cnn?.available) {
    const score = cnn.score;
    const cColor = score < 25 ? 'var(--bull)' : score > 75 ? 'var(--bear)' : 'var(--neutral)';
    if ($('qCNNFG'))      { $('qCNNFG').textContent = score?.toFixed(0) ?? '—'; $('qCNNFG').style.color = cColor; }
    if ($('qCNNRating'))  { $('qCNNRating').textContent = (cnn.rating ?? '—').replace(/_/g,' ').toUpperCase(); $('qCNNRating').style.color = cColor; }
    if ($('qCNNPrev1d')) $('qCNNPrev1d').textContent = cnn.prev1d?.toFixed(0) ?? '—';
    if ($('qCNNPrev1w')) $('qCNNPrev1w').textContent = cnn.prev1w?.toFixed(0) ?? '—';
  }
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function renderAlerts(alerts) {
  const el = $('qAlertsList');
  if (!el) return;
  if (!alerts?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px">No alerts yet</div>';
    return;
  }
  const sevColor = { HIGH: 'var(--bear)', MEDIUM: '#fbbf24', LOW: 'var(--muted)' };
  el.innerHTML = alerts.slice(0, 15).map(a => `
    <div style="padding:6px 0;border-bottom:0.5px solid var(--border);font-size:10px">
      <span style="color:${sevColor[a.severity] ?? 'var(--muted)'}">▸ ${a.type.replace(/_/g,' ')}</span>
      <span style="color:var(--text);margin-left:5px">${a.symbol}</span>
      <div style="color:var(--muted);margin-top:2px">${a.message}</div>
      <div style="color:var(--muted2);font-size:9px;font-family:var(--mono)">${a.timestamp?.slice(0,19).replace('T',' ') ?? ''}</div>
    </div>`).join('');
}

// ── Sector Breadth ────────────────────────────────────────────────────────────
function renderBreadth(breadth) {
  if (!breadth) return;

  const color = breadth.score > 2 ? 'var(--bull)' : breadth.score < -2 ? 'var(--bear)' : 'var(--neutral)';
  if ($('qBreadthPct'))    { $('qBreadthPct').textContent = breadth.breadthPct != null ? `${(breadth.breadthPct * 100).toFixed(0)}%` : 'N/A'; $('qBreadthPct').style.color = color; }
  if ($('qBreadthRegime')) { $('qBreadthRegime').textContent = (breadth.regime ?? '—').replace(/_/g,' '); $('qBreadthRegime').style.color = color; }
  if ($('qB20'))  $('qB20').textContent  = breadth.pct20  != null ? `${breadth.above20}/${breadth.total} (${(breadth.pct20*100).toFixed(0)}%)` : '—';
  if ($('qB50'))  $('qB50').textContent  = breadth.pct50  != null ? `${breadth.above50}/${breadth.total} (${(breadth.pct50*100).toFixed(0)}%)` : '—';
  if ($('qB200')) $('qB200').textContent = breadth.pct200 != null ? `${breadth.above200}/${breadth.total} (${(breadth.pct200*100).toFixed(0)}%)` : '—';

  // Sector grid
  const grid = $('qSectorGrid');
  if (grid && breadth.details) {
    grid.innerHTML = Object.entries(breadth.details).map(([ticker, d]) => {
      const bulls = [d.above20, d.above50, d.above200].filter(Boolean).length;
      const bg    = bulls === 3 ? 'var(--bull-dim)' : bulls === 0 ? 'var(--bear-dim)' : '#27272a';
      const tc    = bulls === 3 ? 'var(--bull)' : bulls === 0 ? 'var(--bear)' : 'var(--muted)';
      const dots  = [
        `<span title="20d EMA" style="color:${d.above20 ? 'var(--bull)' : 'var(--bear)'}">●</span>`,
        `<span title="50d EMA" style="color:${d.above50 ? 'var(--bull)' : 'var(--bear)'}">●</span>`,
        `<span title="200d EMA" style="color:${d.above200 ? 'var(--bull)' : 'var(--bear)'}">●</span>`,
      ].join('');
      const pctStr = d.pctFrom200 != null ? `${d.pctFrom200 >= 0 ? '+' : ''}${d.pctFrom200.toFixed(1)}%` : '';
      return `<div style="background:${bg};border:0.5px solid var(--border);border-radius:4px;padding:5px 7px">
        <div style="font-size:10px;font-weight:700;color:${tc};margin-bottom:3px">${ticker}</div>
        <div style="font-size:9px;letter-spacing:2px">${dots}</div>
        <div style="font-size:8px;font-family:var(--mono);color:var(--muted);margin-top:2px">${pctStr}</div>
      </div>`;
    }).join('');
  }
}

// ── Credit Spread ─────────────────────────────────────────────────────────────
function renderCreditSpread(cs) {
  if (!cs?.available) {
    if ($('qCSZscore')) $('qCSZscore').textContent = 'N/A';
    if ($('qCSSignal')) { $('qCSSignal').textContent = 'Data unavailable'; $('qCSSignal').style.color = 'var(--muted)'; }
    return;
  }
  const color = cs.zScore > 1 ? 'var(--bull)' : cs.zScore < -1 ? 'var(--bear)' : 'var(--neutral)';
  if ($('qCSZscore')) { $('qCSZscore').textContent = cs.zScore?.toFixed(2) ?? '—'; $('qCSZscore').style.color = color; }
  if ($('qCSSignal')) { $('qCSSignal').textContent = (cs.signal ?? '—').replace(/_/g,' '); $('qCSSignal').style.color = color; }
  if ($('qCSScore'))  { $('qCSScore').textContent = `${cs.score >= 0 ? '+' : ''}${cs.score?.toFixed(1)}`; $('qCSScore').style.color = color; }
  if ($('qCSTrend'))  { const v = cs.trend; $('qCSTrend').textContent = v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'; $('qCSTrend').style.color = v > 0 ? 'var(--bull)' : v < 0 ? 'var(--bear)' : 'var(--muted)'; }
  if ($('qCSInterp')) { $('qCSInterp').textContent = (cs.interpretation ?? '—').replace(/_/g,' '); $('qCSInterp').style.color = color; }
}

// ── Volume Profile stats (text panels) ───────────────────────────────────────
function renderVolumeProfileStats(vp) {
  if (!vp) return;
  const spotColor = vp.spot > vp.vah ? 'var(--bull)' : vp.spot < vp.val ? 'var(--bear)' : 'var(--neutral)';
  const distColor = vp.spotVsVPOC > 0 ? 'var(--bull)' : vp.spotVsVPOC < 0 ? 'var(--bear)' : 'var(--muted)';

  if ($('qVPOC'))      $('qVPOC').textContent      = vp.vpoc?.toFixed(2) ?? '—';
  if ($('qVAH'))       $('qVAH').textContent        = vp.vah?.toFixed(2)  ?? '—';
  if ($('qVAL'))       $('qVAL').textContent        = vp.val?.toFixed(2)  ?? '—';
  if ($('qVPOCDist'))  { $('qVPOCDist').textContent = `${vp.spotVsVPOC >= 0 ? '+' : ''}${vp.spotVsVPOC?.toFixed(2)}%`; $('qVPOCDist').style.color = distColor; }
  if ($('qVPOCStatus')){ $('qVPOCStatus').textContent = (vp.interpretation ?? '—').replace(/_/g,' '); $('qVPOCStatus').style.color = spotColor; }

  // Labels below chart
  if ($('qVALLabel'))  $('qVALLabel').textContent  = vp.val?.toFixed(2)  ?? '—';
  if ($('qVPOCLabel')) $('qVPOCLabel').textContent = vp.vpoc?.toFixed(2) ?? '—';
  if ($('qVAHLabel'))  $('qVAHLabel').textContent  = vp.vah?.toFixed(2)  ?? '—';
  if ($('qSpotLabel')) $('qSpotLabel').textContent = vp.spot?.toFixed(2) ?? '—';
}

// ── Volume Profile chart ──────────────────────────────────────────────────────
function renderVolumeProfileChart(vp) {
  const canvas = $('qVolProfileChart');
  if (!canvas || !vp?.buckets?.length) return;

  if (volProfileChartQ) { volProfileChartQ.destroy(); volProfileChartQ = null; }

  // Downsample to 30 visible buckets for cleanliness
  const step = Math.max(1, Math.floor(vp.buckets.length / 30));
  const bkts = vp.buckets.filter((_, i) => i % step === 0);

  const labels = bkts.map(b => b.price.toFixed(1));
  const data   = bkts.map(b => b.volume);
  const maxVol = Math.max(...data) || 1;

  // Color: VPOC = gold, VAH/VAL zone = blue, spot = green/red, rest = muted
  const colors = bkts.map(b => {
    const p = b.price;
    if (Math.abs(p - vp.vpoc) < (vp.priceHigh - vp.priceLow) / vp.buckets.length * step * 1.5)
      return '#fbbf24'; // VPOC = gold
    if (p >= vp.val && p <= vp.vah)
      return '#3b82f677'; // value area = blue semi-transparent
    return '#3f3f46';
  });
  // Spot bucket — color green if above VPOC, red if below
  const spotIdx = bkts.reduce((best, b, i) => Math.abs(b.price - vp.spot) < Math.abs(bkts[best].price - vp.spot) ? i : best, 0);
  colors[spotIdx] = vp.spot >= vp.vpoc ? '#34d399' : '#fb7185';

  volProfileChartQ = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Volume', data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      indexAxis: 'y',  // horizontal bars
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: '#111113', borderColor: '#27272a', borderWidth: 1,
        titleColor: '#f4f4f5', bodyColor: '#71717a',
        titleFont: { family: 'Geist Mono', size: 9 }, bodyFont: { family: 'Geist Mono', size: 9 },
        callbacks: { label: ctx => ` Vol: ${ctx.raw.toLocaleString()}` },
      }},
      scales: {
        x: { display: false },
        y: { ticks: { color: '#52525b', font: { family: 'Geist Mono', size: 8 }, maxTicksLimit: 12 }, grid: { color: '#1a1a1d' } },
      },
    },
  });
}

// ── Return Distribution ───────────────────────────────────────────────────────
function renderDistribution(dist) {
  if (!dist) return;

  const retColor = dist.annualizedReturn >= 0 ? 'var(--bull)' : 'var(--bear)';
  const sharpeColor = dist.sharpe > 1 ? 'var(--bull)' : dist.sharpe > 0.5 ? 'var(--neutral)' : 'var(--bear)';
  const skewColor   = dist.skewness < -0.3 ? 'var(--bear)' : dist.skewness > 0.3 ? 'var(--bull)' : 'var(--muted)';
  const kurtColor   = dist.excessKurtosis > 3 ? 'var(--bear)' : 'var(--muted)';

  if ($('qDistRet'))  { $('qDistRet').textContent = `${(dist.annualizedReturn * 100).toFixed(1)}%`; $('qDistRet').style.color = retColor; }
  if ($('qDistVol'))  $('qDistVol').textContent = `${(dist.annualizedVol * 100).toFixed(1)}%`;
  if ($('qSharpe'))   { $('qSharpe').textContent = dist.sharpe?.toFixed(2) ?? '—'; $('qSharpe').style.color = sharpeColor; }
  if ($('qSortino'))  { $('qSortino').textContent = dist.sortino?.toFixed(2) ?? '—'; $('qSortino').style.color = dist.sortino > 1 ? 'var(--bull)' : 'var(--muted)'; }
  if ($('qCalmar'))   { $('qCalmar').textContent = dist.calmar?.toFixed(2) ?? '—'; $('qCalmar').style.color = dist.calmar > 0.5 ? 'var(--bull)' : 'var(--muted)'; }
  if ($('qOmega'))    { $('qOmega').textContent = dist.omega > 50 ? '∞' : dist.omega?.toFixed(2) ?? '—'; $('qOmega').style.color = dist.omega > 1.5 ? 'var(--bull)' : 'var(--muted)'; }
  if ($('qSkew'))     { $('qSkew').textContent = `${dist.skewness?.toFixed(3)} (${(dist.regime ?? '').replace(/_/g,' ')})`; $('qSkew').style.color = skewColor; }
  if ($('qKurt'))     { $('qKurt').textContent = `${dist.excessKurtosis?.toFixed(3)} (${(dist.kurtosisRegime ?? '').replace(/_/g,' ')})`; $('qKurt').style.color = kurtColor; }
  if ($('qVar95'))    { $('qVar95').textContent = `${dist.var95?.toFixed(2)}%`; $('qVar95').style.color = 'var(--bear)'; }
  if ($('qVar99'))    { $('qVar99').textContent = `${dist.var99?.toFixed(2)}%`; $('qVar99').style.color = 'var(--bear)'; }
  if ($('qCVar95'))   { $('qCVar95').textContent = `${dist.cvar95?.toFixed(2)}%`; $('qCVar95').style.color = 'var(--bear)'; }
  if ($('qMaxDD'))    { $('qMaxDD').textContent = `${dist.maxDrawdown?.toFixed(2)}%`; $('qMaxDD').style.color = 'var(--bear)'; }
}

// ── Vol Surface heatmap ───────────────────────────────────────────────────────
function ivToColor(iv) {
  // iv is a fraction (e.g. 0.20 = 20% IV)
  if (!iv || !isFinite(iv)) return '#27272a';
  const pct = Math.min(1, Math.max(0, (iv - 0.08) / 0.50)); // map 8%–58% → 0–1
  // Blue (low) → green (mid) → amber (high) → red (extreme)
  if (pct < 0.25) return `rgba(29,78,216,${0.4 + pct * 1.6})`; // blue
  if (pct < 0.50) return `rgba(4,120,87,${0.4 + (pct-0.25) * 2.4})`; // green
  if (pct < 0.75) return `rgba(217,119,6,${0.6 + (pct-0.50) * 1.6})`; // amber
  return `rgba(220,38,38,${0.6 + (pct-0.75) * 1.6})`; // red
}

function renderVolSurface(surface) {
  const el = $('qVolSurface');
  if (!el) return;

  if (!surface?.surface?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px">Vol surface unavailable (options data required)</div>';
    return;
  }

  const spot = surface.spot;

  // Collect all unique moneyness buckets across all expirations
  const moneynessSet = new Set();
  for (const exp of surface.surface) {
    for (const s of (exp.strikes ?? [])) {
      const m = ((s.strike - spot) / spot * 100).toFixed(0);
      moneynessSet.add(parseFloat(m));
    }
  }
  // Focus on ±25% from ATM; step by 1% and limit to 40 columns for readability
  const allCols = [...moneynessSet].sort((a, b) => a - b)
    .filter(m => m >= -25 && m <= 15);
  // If too many columns, stride to keep ≤ 40
  const stride = Math.max(1, Math.ceil(allCols.length / 40));
  const cols = allCols.filter((_, i) => i % stride === 0);

  const rows = surface.surface.slice(0, 8); // max 8 expirations

  const th = col => {
    const isATM = Math.abs(col) <= 2;
    return `<th style="font-size:8px;font-family:var(--mono);padding:3px 4px;text-align:center;color:${isATM?'var(--text)':'var(--muted)'};background:${isATM?'#27272a':'var(--panel)'};border:0.5px solid var(--border);white-space:nowrap">
      ${col >= 0 ? '+' : ''}${col}%
    </th>`;
  };

  const cells = rows.map(exp => {
    const strikeMap = {};
    for (const s of (exp.strikes ?? [])) {
      const m = Math.round((s.strike - spot) / spot * 100);
      strikeMap[m] = s;
    }
    const tds = cols.map(col => {
      const s = strikeMap[col];
      const iv = s?.midIV ?? s?.callIV ?? s?.putIV;
      const bg = ivToColor(iv);
      const isATM = Math.abs(col) <= 2;
      return `<td style="font-size:8px;font-family:var(--mono);padding:3px 5px;text-align:center;
        background:${bg};border:0.5px solid var(--border);
        color:${iv ? '#f4f4f5' : 'var(--muted)'};font-weight:${isATM ? '700' : '400'}">
        ${iv ? (iv * 100).toFixed(1) : '·'}
      </td>`;
    }).join('');
    return `<tr>
      <td style="font-size:8px;font-family:var(--mono);padding:3px 8px;color:var(--muted);border:0.5px solid var(--border);white-space:nowrap;background:var(--panel)">
        ${exp.dte}d
      </td>
      ${tds}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table style="border-collapse:collapse;font-size:9px;width:100%">
      <thead>
        <tr>
          <th style="font-size:8px;padding:3px 8px;text-align:left;color:var(--muted);background:var(--panel);border:0.5px solid var(--border)">DTE</th>
          ${cols.map(th).join('')}
        </tr>
      </thead>
      <tbody>${cells}</tbody>
    </table>`;
}

// ── Correlation Matrix ────────────────────────────────────────────────────────
function corrToColor(c) {
  // Map -1 to +1 → blue to red with gray midpoint
  const v = Math.max(-1, Math.min(1, c));
  if (v >= 0) {
    const r = Math.round(220 * v);
    const g = Math.round(38  * v);
    const b = Math.round(38  * v);
    return `rgba(${220-r/2},${38+r/3},${38},${0.2 + Math.abs(v) * 0.7})`;
  } else {
    const a = Math.abs(v);
    return `rgba(29,78,216,${0.2 + a * 0.7})`;
  }
}

function renderCorrMatrix(cm) {
  const el = $('qCorrMatrix');
  if (!el) return;
  if (!cm?.tickers?.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px">Correlation data unavailable</div>';
    return;
  }
  const { tickers, correlations } = cm;
  const th = t => `<th style="font-size:8px;font-family:var(--mono);padding:3px 5px;text-align:center;color:var(--muted);background:var(--panel);border:0.5px solid var(--border)">${t}</th>`;
  const header = `<tr><th style="background:var(--panel);border:0.5px solid var(--border)"></th>${tickers.map(th).join('')}</tr>`;
  const rows = tickers.map(ta => {
    const cells = tickers.map(tb => {
      const c = correlations[ta]?.[tb] ?? 0;
      const isDiag = ta === tb;
      const bg = isDiag ? '#27272a' : corrToColor(c);
      const txt = isDiag ? '–' : c.toFixed(2);
      const textColor = Math.abs(c) > 0.5 ? '#f4f4f5' : '#a1a1aa';
      return `<td style="font-size:8px;font-family:var(--mono);padding:3px 5px;text-align:center;background:${bg};border:0.5px solid var(--border);color:${textColor}">${txt}</td>`;
    }).join('');
    return `<tr>
      <th style="font-size:8px;font-family:var(--mono);padding:3px 6px;text-align:right;color:var(--muted);background:var(--panel);border:0.5px solid var(--border)">${ta}</th>
      ${cells}
    </tr>`;
  }).join('');
  el.innerHTML = `<table style="border-collapse:collapse;width:100%"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
}

// ── Main load ─────────────────────────────────────────────────────────────────
async function loadData() {
  setStatus(false);
  const sym = currentSymbol;

  const [quantRes, biasRes, cotRes, sentRes, alertRes, breadthRes] = await Promise.allSettled([
    fetch(`/api/quant?symbol=${sym}`).then(r => r.json()),
    fetch(`/api/bias?symbol=${sym}`).then(r => r.json()),
    fetch(`/api/cot`).then(r => r.json()),
    fetch(`/api/sentiment?symbol=${sym}`).then(r => r.json()),
    fetch(`/api/alerts?limit=20`).then(r => r.json()),
    fetch(`/api/breadth?symbol=${sym}`).then(r => r.json()),
  ]);

  const q      = quantRes.status    === 'fulfilled' && quantRes.value?.ok    ? quantRes.value.data    : null;
  const b      = biasRes.status     === 'fulfilled' && biasRes.value?.ok     ? biasRes.value.data     : null;
  const cot    = cotRes.status      === 'fulfilled' && cotRes.value?.ok      ? cotRes.value.data      : null;
  const sent   = sentRes.status     === 'fulfilled' && sentRes.value?.ok     ? sentRes.value.data     : null;
  const alts   = alertRes.status    === 'fulfilled' && alertRes.value?.ok    ? alertRes.value.data    : [];
  const brdth  = breadthRes.status  === 'fulfilled' && breadthRes.value?.ok  ? breadthRes.value.data  : null;

  if (q) {
    if ($('computedAt')) $('computedAt').textContent = new Date(q.computedAt).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    renderRegime(q.regime);
    renderHurst(q.hurst);
    renderOUScores(q.ouSpreads);
    renderVRP(q.vrp, q.vixRaw);
    renderVIXChart(q.vixRaw?.series ?? {});
    renderFearGreed(q.fearGreed, q.macro);
    renderTSMOM(q.tsmom);
    renderCrossAsset(q.crossAsset);
    renderDistribution(q.distribution);
    renderVolumeProfileStats(q.volumeProfile);
    renderVolumeProfileChart(q.volumeProfile);
    setStatus(true);
  }

  // Breadth data (from dedicated /api/breadth endpoint)
  if (brdth) {
    renderBreadth(brdth.breadth ?? b?.breadth);
    renderCreditSpread(brdth.creditSpread ?? b?.creditSpread);
    renderCorrMatrix(brdth.corrMatrix);
    // If quant didn't have it, use breadth endpoint's distribution/volumeProfile
    if (!q?.distribution)   renderDistribution(brdth.distribution);
    if (!q?.volumeProfile)  { renderVolumeProfileStats(brdth.volumeProfile); renderVolumeProfileChart(brdth.volumeProfile); }
  } else if (b) {
    // Fall back to bias result's breadth/creditSpread
    renderBreadth(b.breadth);
    renderCreditSpread(b.creditSpread);
  }

  // Load OFI/intraday from momentum endpoint (non-blocking)
  fetch(`/api/momentum?symbol=${sym}`).then(r => r.json()).then(json => {
    if (!json.ok) return;
    renderOFI(json.data.ofi, json.data.intraday);
    if (!q?.tsmom) renderTSMOM(json.data.tsmom);
    if (!q?.crossAsset) renderCrossAsset(json.data.crossAsset);
  }).catch(() => {});

  // Vol surface (non-blocking — only works for optionable symbols)
  fetch(`/api/volsurface?symbol=${sym}`).then(r => r.json()).then(json => {
    if (!json.ok) return;
    renderVolSurface(json.data);
  }).catch(() => { renderVolSurface(null); });

  if (b) {
    renderKelly(b);
    renderCI(b);
    if (!cot  && b.cot)       renderCOT(b.cot);
    if (!sent && b.sentiment) renderSentiment(b.sentiment);
  }

  renderCOT(cot ?? b?.cot ?? null);
  renderSentiment(sent ?? b?.sentiment ?? null);
  renderAlerts(alts);

  const upEl = $('lastUpdate');
  if (upEl) upEl.textContent = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}

function init() {
  // Restore symbol propagated by the SPA router across page transitions
  if (window._routerSymbol) { currentSymbol = window._routerSymbol; delete window._routerSymbol; }

  const hiddenSel = $('symbolSelect');
  if (hiddenSel) hiddenSel.value = currentSymbol;

  window.initTickerDropdown(value => {
    currentSymbol = value;
    loadData();
  });
  loadData();

  // Register cleanup for the SPA router (no timer in quant, but keeps pattern consistent)
  window._pageCleanup = () => {};
}

document.addEventListener('DOMContentLoaded', init);
