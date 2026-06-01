'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentSymbol  = 'SPY';
let gexChart       = null;
let vixChart       = null;
let refreshTimer   = null;
let _lastScore     = null; // tracks previous composite for ticker animation
const REFRESH_MS   = 5 * 60 * 1000;

// ── Utilities ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt  = (v, dec=2) => v != null ? Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—';
const fmtB = v => v != null ? (Math.abs(v) >= 1e9 ? `${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : fmt(v,0)) : '—';
const sign  = v => v >= 0 ? `+${fmt(v,2)}` : fmt(v,2);
const pct   = v => v != null ? `${(v*100).toFixed(1)}%` : '—';
const fmtPct = v => v != null ? `${Number(v).toFixed(1)}%` : '—';

function setColor(el, score) {
  if (!el) return;
  el.className = el.className.replace(/\b(bull|bear|neutral|warn|text-muted)\b/g, '');
  if (score > 1)       el.classList.add('bull');
  else if (score < -1) el.classList.add('bear');
  else                 el.classList.add('text-muted');
}

function scoreColor(score) {
  if (score > 1)  return 'var(--bull)';
  if (score < -1) return 'var(--bear)';
  return 'var(--neutral)';
}

function setStatus(ok) {
  const dot = $('statusDot');
  if (dot) dot.className = ok ? 'status-dot live' : 'status-dot';
}

function setLastUpdate() {
  const el = $('lastUpdate');
  if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}

// ── GEX chart ───────────────────────────────────────────────────────────────
function renderGEXChart(profile, spot, keyLevels) {
  const canvas = $('gexChart');
  if (!canvas || !profile?.length) return;

  // Filter to strikes within ±10% of spot
  const lo = spot * 0.90, hi = spot * 1.10;
  const filtered = profile.filter(r => r.strike >= lo && r.strike <= hi);
  if (!filtered.length) return;

  const labels   = filtered.map(r => r.strike);
  const gexCalls = filtered.map(r => (r.gexCall ?? 0) / 1e9);
  const gexPuts  = filtered.map(r => (r.gexPut  ?? 0) / 1e9);

  if (gexChart) { gexChart.destroy(); gexChart = null; }

  gexChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Call GEX ($B)',
          data:   gexCalls,
          backgroundColor: filtered.map(r =>
            Math.abs(r.strike - spot) / spot < 0.01 ? '#3B82F6' : '#3B82F6AA'
          ),
          borderWidth: 0,
          borderRadius: 2,
        },
        {
          label: 'Put GEX ($B)',
          data:   gexPuts,
          backgroundColor: filtered.map(r =>
            Math.abs(r.strike - spot) / spot < 0.01 ? '#EF4444' : '#EF4444AA'
          ),
          borderWidth: 0,
          borderRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111113',
          borderColor: '#27272a',
          borderWidth: 1,
          titleColor: '#f4f4f5',
          bodyColor: '#71717a',
          titleFont: { family: 'Geist Mono', size: 11 },
          bodyFont: { family: 'Geist Mono', size: 10 },
          callbacks: {
            title: ctx => `Strike $${ctx[0].label}`,
            label: ctx => `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(3)}B`,
          },
        },
        annotation: buildGEXAnnotations(spot, keyLevels),
      },
      scales: {
        x: {
          stacked: false,
          grid: { color: '#1a1a1d', lineWidth: 0.5 },
          ticks: { color: '#52525b', font: { family: 'Geist Mono', size: 9 }, maxRotation: 0, maxTicksLimit: 12 },
        },
        y: {
          stacked: false,
          grid: { color: '#1a1a1d', lineWidth: 0.5 },
          ticks: { color: '#52525b', font: { family: 'Geist Mono', size: 9 },
            callback: v => `${v.toFixed(2)}B` },
        },
      },
    },
  });
}

function buildGEXAnnotations(spot, kl) {
  if (!kl) return {};
  const lines = {};

  const addLine = (id, value, color, label, dash) => {
    if (!value) return;
    lines[id] = {
      type: 'line', scaleID: 'x',
      value,
      borderColor: color,
      borderWidth: dash ? 1 : 1.5,
      borderDash: dash || [],
      label: {
        display: true, content: label,
        color,
        font: { family: 'Geist Mono', size: 9 },
        position: 'start',
        yAdjust: -10,
        backgroundColor: 'transparent',
      },
    };
  };

  addLine('spot',      spot,           '#ffffff', `Spot $${spot?.toFixed(2)}`);
  addLine('gammaFlip', kl.gammaFlip,   '#F59E0B', 'γ-Flip', [4,2]);
  addLine('callWall',  kl.callWall,    '#60A5FA', 'Call Wall', [3,2]);
  addLine('putWall',   kl.putWall,     '#F87171', 'Put Wall', [3,2]);
  addLine('maxPain',   kl.maxPain,     '#34D399', 'Max Pain', [2,2]);

  return { annotations: lines };
}

// ── VIX chart ────────────────────────────────────────────────────────────────
function renderVIXChart(vixSeries) {
  const canvas = $('vixChart');
  if (!canvas || !vixSeries?.vix?.length) return;

  const labels = vixSeries.vix.map(d => d.date).slice(-90);
  const sliceVix  = d => (vixSeries[d] ?? []).slice(-90).map(p => p.close);

  if (vixChart) { vixChart.destroy(); vixChart = null; }

  vixChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'VIX9D',  data: sliceVix('vix9d'), borderColor: '#fb7185', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
        { label: 'VIX',    data: sliceVix('vix'),   borderColor: '#e4e4e7', borderWidth: 1.5, pointRadius: 0, tension: 0.3,
          fill: 'origin', backgroundColor: '#27272a33' },
        { label: 'VIX3M',  data: sliceVix('vix3m'), borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111113',
          borderColor: '#27272a',
          borderWidth: 1,
          titleColor: '#f4f4f5',
          bodyColor: '#71717a',
          titleFont: { family: 'Geist Mono', size: 10 },
          bodyFont:  { family: 'Geist Mono', size: 10 },
        },
      },
      scales: {
        x: {
          grid: { color: '#1a1a1d', lineWidth: 0.5 },
          ticks: {
            color: '#52525b', font: { family: 'Geist Mono', size: 9 },
            maxTicksLimit: 8, maxRotation: 0,
            callback: (_, i, arr) => {
              if (i === 0 || i === arr.length - 1 || i % Math.floor(arr.length / 6) === 0)
                return labels[i]?.slice(5); // MM-DD
              return null;
            },
          },
        },
        y: {
          min: 10,
          grid: { color: '#1a1a1d', lineWidth: 0.5 },
          ticks: { color: '#52525b', font: { family: 'Geist Mono', size: 9 },
            stepSize: 5, callback: v => v.toFixed(0) },
        },
      },
    },
  });
}

// ── Pillar bars ──────────────────────────────────────────────────────────────
function renderPillars(pillars) {
  const el = $('pillarList');
  if (!el || !pillars) return;

  const pillarLabels = {
    options_gex: 'GEX',
    trend:       'Trend',
    momentum:    'Momentum',
    volatility:  'Vol',
    macro:       'Macro',
  };

  const order = ['options_gex', 'trend', 'momentum', 'volatility', 'macro'];

  const rows = order
    .filter(cat => pillars[cat])
    .map((cat, i) => {
      const data  = pillars[cat];
      const score = data.pillarScore ?? 0;
      const pct   = Math.abs(score) / 10 * 50;
      const isBull = score >= 0;
      const color  = scoreColor(score);
      const label  = pillarLabels[cat] ?? cat;
      const sigCount = data.signals?.length ?? 0;
      return `
        <div class="pillar-row" style="animation-delay:${i * 40}ms">
          <span class="pillar-name">${label}</span>
          <div class="pillar-bar-wrap">
            <div class="pillar-bar ${isBull ? 'bull' : 'bear'}"
                 style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="pillar-score" style="color:${color}">${sign(score)}</span>
          <span class="pillar-count">${sigCount}</span>
        </div>`;
    });

  el.innerHTML = rows.join('');
}

// ── Key levels ladder ─────────────────────────────────────────────────────────
function renderKeyLevels(keyLevels, spot) {
  const el = $('keyLevels');
  if (!el || !keyLevels?.length) return;

  // Trading-UI spec: type-specific label + badge + left-border accent
  const typeMap = {
    GAMMA_FLIP: { badge: 'badge-GAMMA_FLIP', label: 'γ-FLIP'   },
    CALL_WALL:  { badge: 'badge-CALL_WALL',  label: 'CALL WALL' },
    PUT_WALL:   { badge: 'badge-PUT_WALL',   label: 'PUT WALL'  },
    MAX_PAIN:   { badge: 'badge-MAX_PAIN',   label: 'MAX PAIN'  },
    PDH:        { badge: 'badge-PDH',        label: 'PDH'       },
    PDL:        { badge: 'badge-PDL',        label: 'PDL'       },
    BULL_FVG:   { badge: 'badge-BULL_FVG',   label: 'FVG↑'     },
    BEAR_FVG:   { badge: 'badge-BEAR_FVG',   label: 'FVG↓'     },
    ORB_HIGH:   { badge: 'badge-ORB_HIGH',   label: 'ORB HI'   },
    ORB_LOW:    { badge: 'badge-ORB_LOW',    label: 'ORB LO'   },
    ROUND:      { badge: 'badge-neutral',    label: 'ROUND'    },
  };

  const withSpot = [...keyLevels, { type: 'SPOT', price: spot }];
  withSpot.sort((a, b) => b.price - a.price);

  el.innerHTML = withSpot.map(level => {
    const isSpot = level.type === 'SPOT';
    const ts = typeMap[level.type] ?? { badge: 'badge-neutral', label: level.type?.slice(0,8) ?? '—' };
    const dist    = spot && level.price ? ((level.price - spot) / spot * 100) : null;
    const distStr = dist !== null
      ? `<span style="color:${dist >= 0 ? 'var(--bull)' : 'var(--bear)'}">${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%</span>`
      : '—';
    const priceStr = level.price >= 1000
      ? Number(level.price).toFixed(1)
      : `$${Number(level.price).toFixed(2)}`;

    if (isSpot) {
      return `<div class="level-row is-spot type-SPOT">
        <span class="level-badge badge-SPOT">SPOT</span>
        <span class="level-price">${priceStr}</span>
        <span class="level-dist">—</span>
      </div>`;
    }

    return `<div class="level-row type-${level.type}">
      <span class="level-badge ${ts.badge}">${ts.label}</span>
      <span class="level-price">${priceStr}</span>
      <span class="level-dist">${distStr}</span>
    </div>`;
  }).join('');
}

// ── Regime display ────────────────────────────────────────────────────────────
function renderRegime(regime) {
  const regimeDot  = $('regimeDot');
  const regimeName = $('regimeName');
  const regimeConf = $('regimeConf');
  const regimeBars = $('regimeBars');
  if (!regime) return;

  const colors = {
    LOW_VOL_BULL:  '#34d399',
    HIGH_VOL_CHOP: '#fbbf24',
    CRASH_BEAR:    '#fb7185',
    RECOVERY:      '#60a5fa',
  };

  const color = colors[regime.regime] ?? '#71717a';
  if (regimeDot)  regimeDot.style.background = color;
  if (regimeName) { regimeName.textContent = regime.regime?.replace(/_/g, ' '); regimeName.style.color = color; }
  // Show confidence + GEX overlay environment
  const gexEnvLabels = {
    'GEX_PINNING':       { label: 'PINNING',       color: '#F59E0B', icon: '⊟' },
    'GEX_SOFT_SUPPORT':  { label: 'SOFT SUPPORT',  color: '#60a5fa', icon: '⊡' },
    'GEX_WEAK_BREAKOUT': { label: 'WEAK BREAKOUT', color: '#a78bfa', icon: '⊞' },
    'GEX_TRENDING':      { label: 'TRENDING',       color: '#f87171', icon: '⊠' },
  };
  const gexInfo  = regime.gexOverlay ? gexEnvLabels[regime.gexOverlay.environment] : null;
  const confText = `Confidence: ${(regime.confidence * 100).toFixed(0)}%`;
  const gexText  = gexInfo
    ? ` · ${gexInfo.icon} GEX: <span style="color:${gexInfo.color}">${gexInfo.label}</span>`
    : '';
  if (regimeConf) regimeConf.innerHTML = confText + gexText;

  if (regimeBars && regime.allProbs) {
    // Show probability bars only for states with >2% probability
    const visible = Object.entries(regime.allProbs).filter(([, p]) => p > 0.02);
    regimeBars.innerHTML = visible.map(([state, prob]) => {
      const c = colors[state] ?? '#71717a';
      const isActive = state === regime.regime;
      return `<div class="regime-bar-row" style="${isActive ? 'opacity:1' : 'opacity:0.6'}">
        <span class="regime-bar-label">${state.replace(/_/g,' ')}</span>
        <div class="regime-bar-track"><div class="regime-bar-fill" style="width:${(prob*100).toFixed(1)}%;background:${c}"></div></div>
        <span class="regime-bar-pct">${(prob*100).toFixed(0)}%</span>
      </div>`;
    }).join('');

    // If there's GEX overlay description, show it
    if (regime.gexOverlay?.description) {
      regimeBars.innerHTML += `<div style="font-size:9px;color:var(--muted);margin-top:6px;line-height:1.4">${regime.gexOverlay.description}</div>`;
    }
  }
}

// ── Signal log table — cockpit mode ──────────────────────────────────────────
// Trading-UI spec: 28px rows, alternating rows, signed monospace scores,
// directional hover (enter from mouse side), category chips, staggered reveal.
function renderSignalLog(signals) {
  const tbody = $('signalLog');
  if (!tbody || !signals) return;

  const sorted = Object.entries(signals).sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score));

  tbody.innerHTML = sorted.map(([key, sig], i) => {
    const score  = sig.score ?? 0;
    const wt     = sig.normalizedWeight ? `${(sig.normalizedWeight * 100).toFixed(1)}%` : '—';
    const catChip = window.FX ? window.FX.catChip(sig.category) : `<span>${sig.category ?? '—'}</span>`;

    // Score bar: 40px, fill from left/right center
    const absScore = Math.abs(score);
    const pct      = Math.min(absScore / 10 * 100, 100);
    const barColor = score > 0 ? 'var(--bull)' : score < 0 ? 'var(--bear)' : 'var(--muted)';
    const signStr  = score >= 0 ? '+' : '';
    const scoreColor2 = score > 0.5 ? 'var(--bull)' : score < -0.5 ? 'var(--bear)' : 'var(--neutral)';

    const scoreCell = `<div class="sig-bar-wrap">
      <span class="sig-score" style="color:${scoreColor2}">${signStr}${score.toFixed(1)}</span>
      <div class="sig-mini-bar"><div class="sig-mini-fill" style="width:${pct}%;background:${barColor}"></div></div>
    </div>`;

    return `<tr style="--row-delay:${Math.min(i * 15, 600)}ms">
      <td>${catChip}</td>
      <td style="color:var(--text)">${sig.label ?? key}</td>
      <td>${scoreCell}</td>
      <td class="sig-wt">${wt}</td>
      <td class="sig-detail" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${sig.detail ?? '—'}</td>
    </tr>`;
  }).join('');

  if (window.FX) window.FX.staggerRows(tbody, 15, 600);
}

// ── Three-horizon sub-composites ─────────────────────────────────────────────
// Shows scalp / session / macro sub-composites below the directive card.
function renderThreeHorizon(d) {
  const el = $('threeHorizon');
  if (!el) return;

  const horizons = [
    { key: 'scalpBias',   label: 'Scalp',   hint: '<30 min' },
    { key: 'sessionBias', label: 'Session',  hint: 'Full day' },
    { key: 'macroBias',   label: 'Macro',    hint: 'Days/wks' },
  ];

  const rows = horizons.map((h, i) => {
    const bias  = d[h.key];
    if (!bias || bias.n === 0) return '';
    const score  = bias.score ?? 0;
    const label  = bias.label ?? 'NEUTRAL';
    const isBull = score >= 0;
    const pct    = Math.abs(score) / 100 * 50;   // maps ±100 → 0-50% of half
    const color  = score > 20 ? 'var(--bull)' : score < -20 ? 'var(--bear)' : 'var(--neutral)';
    const badgeClass = score >= 30 ? 'badge-bull' : score <= -30 ? 'badge-bear' : 'badge-neutral';
    const signedScore = `${score >= 0 ? '+' : ''}${score}`;

    return `<div class="horizon-row" style="animation-delay:${i * 60}ms">
      <span class="horizon-label">${h.label}</span>
      <div class="horizon-bar-track">
        <div class="horizon-bar-fill ${isBull ? 'bull' : 'bear'}"
             style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="horizon-score" style="color:${color}">${signedScore}</span>
      <span class="horizon-badge stat-badge ${badgeClass}" style="min-width:52px;text-align:center">${label}</span>
    </div>`;
  }).join('');

  el.innerHTML = rows
    ? `<div class="horizon-section">
        <div class="horizon-title">Bias by Horizon</div>
        ${rows}
       </div>`
    : '';
}

// ── Directional hover enter effect ────────────────────────────────────────────
// Detects which horizontal side the mouse enters each signal row from,
// sets CSS custom property --enter-side so the fill animates from that edge.
// Applied once; event delegation covers dynamically added rows.
(function initDirectionalHover() {
  document.addEventListener('mouseover', function (e) {
    const tr = e.target && e.target.closest && e.target.closest('.signal-table tbody tr');
    if (!tr) return;
    const rect = tr.getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    tr.style.setProperty('--enter-side', side);
  });
})();

// ── Cross-asset list ──────────────────────────────────────────────────────────
function renderCrossAsset(crossAsset) {
  const el = $('crossAssetList');
  if (!el || !crossAsset) return;

  const { tickerScores, regime, riskOnScore, riskOffScore } = crossAsset;
  if (!tickerScores) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px 0">No cross-asset data</div>';
    return;
  }

  const TICKER_ORDER = ['SPY','QQQ','IWM','HYG','TLT','GLD','XLY','XLK','XLF'];
  const riskOffSet   = new Set(['TLT','GLD','VIX']);

  // Regime summary header
  const regimeColor = crossAsset.composite > 5 ? 'var(--bull)' : crossAsset.composite < -5 ? 'var(--bear)' : 'var(--neutral)';
  const roColor     = (riskOnScore ?? 0) >= 0  ? 'var(--bull)' : 'var(--bear)';
  const rfColor     = (riskOffScore ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)';

  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted2)">
      Regime: <span style="color:${regimeColor}">${regime ?? '—'}</span>
    </span>
    <span style="font-size:9px;font-family:var(--mono);color:var(--muted)">
      R-On <span style="color:${roColor}">${(riskOnScore ?? 0) >= 0 ? '+' : ''}${(riskOnScore ?? 0).toFixed(1)}</span>
      &nbsp;R-Off <span style="color:${rfColor}">${(riskOffScore ?? 0) >= 0 ? '+' : ''}${(riskOffScore ?? 0).toFixed(1)}</span>
    </span>
  </div>`;

  // Data table — cockpit-mode rows
  const rows = TICKER_ORDER
    .filter(t => tickerScores[t] != null)
    .map(t => {
      const sc     = tickerScores[t];
      const color  = scoreColor(sc);
      const isOff  = riskOffSet.has(t);
      const arrow  = sc > 1 ? '<span style="color:var(--bull)">↑</span>'
                   : sc < -1 ? '<span style="color:var(--bear)">↓</span>'
                   : '<span style="color:var(--muted)">→</span>';
      const typeLabel = isOff ? 'RISK-OFF' : 'RISK-ON';
      const typeColor = isOff ? 'var(--bear)' : 'var(--bull)';
      return `<tr>
        <td class="ca-ticker-cell" style="color:${isOff ? 'var(--muted)' : 'var(--text)'}">${t}</td>
        <td style="font-size:9px;color:${typeColor};font-family:var(--mono)">${typeLabel}</td>
        <td class="ca-score-cell" style="color:${color}">${arrow} ${sc >= 0 ? '+' : ''}${sc.toFixed(1)}</td>
      </tr>`;
    }).join('');

  el.innerHTML = header + `<table class="ca-table">
    <thead><tr>
      <th>Ticker</th><th>Type</th><th>Score</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Session directive renderer ────────────────────────────────────────────────
let _lastDirective = null;
function renderDirective(directive, color, reason, eventRisk, dataQuality) {
  const card   = $('directiveCard');
  const textEl = $('directiveText');
  const rsn    = $('directiveReason');
  if (!card || !textEl || !directive) return;

  card.className = 'directive-card ' + (color === 'bull' ? 'bull-dir' : color === 'bear' ? 'bear-dir' : color === 'warn' ? 'warn-dir' : 'neutral-dir');

  if (directive !== _lastDirective) {
    textEl.textContent = directive;
    textEl.classList.remove('updated');
    void textEl.offsetWidth;
    textEl.classList.add('updated');
    _lastDirective = directive;
  }

  if (rsn) rsn.textContent = reason ?? '';

  // Event risk badge — shown when Kelly is halved near FOMC/CPI/NFP
  let badge = card.querySelector('.event-risk-badge');
  if (eventRisk) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'event-risk-badge';
      card.appendChild(badge);
    }
    badge.textContent = '⚠ EVENT RISK — SIZE HALVED';
  } else if (badge) {
    badge.remove();
  }

  // Data quality degraded indicator
  let dqBadge = card.querySelector('.dq-badge');
  if (dataQuality?.degraded) {
    if (!dqBadge) {
      dqBadge = document.createElement('div');
      dqBadge.className = 'dq-badge';
      card.appendChild(dqBadge);
    }
    dqBadge.textContent = `⚠ STALE DATA — ${dataQuality.issues.join(', ')}`;
  } else if (dqBadge) {
    dqBadge.remove();
  }
}

// ── Main data load ────────────────────────────────────────────────────────────
async function loadData() {
  setStatus(false);
  const sym = currentSymbol;

  try {
    const res  = await fetch(`/api/bias?symbol=${sym}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    const d = json.data;

    // ── Dismiss loading overlay on first successful load ──────────────────
    const overlay = $('loadingOverlay');
    if (overlay && !overlay.classList.contains('fade-out')) {
      overlay.classList.add('fade-out');
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 450);
    }

    // ── Gauge: draw canvas + set DOM text ────────────────────────────────
    const prevScore = _lastScore; // capture before overwriting
    _lastScore = d.composite;
    updateGauge(d.composite, d.label, d.confidence, d.ciLow, d.ciHigh);

    // ── FX: animate score ticker + glow (runs after gauge sets final text) ──
    const scoreEl = $('gaugeScore');
    if (scoreEl && window.FX) {
      window.FX.setScoreClass(scoreEl, d.composite);
      window.FX.setGaugeGlow(d.composite);
      window.FX.pulseGauge();
      // Animate on subsequent updates (prevScore is null on first load)
      if (prevScore !== null && prevScore !== d.composite) {
        window.FX.animateScore(scoreEl, prevScore, d.composite);
        window.FX.showToast(`${sym} — bias ${d.composite >= 0 ? '+' : ''}${d.composite}`);
      }
    }

    // Spot
    const spotStr = `$${Number(d.spot).toFixed(2)}`;
    if ($('spotPrice'))  $('spotPrice').textContent  = spotStr;
    if ($('spotRight'))  $('spotRight').textContent  = spotStr;

    // Kelly — flash values that changed
    if (d.kelly) {
      const k = d.kelly;
      if ($('kellyDir')) {
        $('kellyDir').textContent  = k.direction;
        $('kellyDir').style.color  = k.direction === 'LONG' ? 'var(--bull)' : 'var(--bear)';
        if (window.FX) window.FX.flashEl($('kellyDir'));
      }
      if ($('kellyRisk')) {
        $('kellyRisk').textContent = k.riskPct;
        $('kellyRisk').style.color = scoreColor(d.composite);
        if (window.FX) window.FX.flashEl($('kellyRisk'));
      }
      if ($('kellyWP'))        $('kellyWP').textContent       = pct(k.winProbability);
      if ($('kellyFull'))      $('kellyFull').textContent     = pct(k.fullKelly);
      if ($('kellyRationale')) $('kellyRationale').textContent = k.rationale;
    }

    // ── Session directive ─────────────────────────────────────────────────
    renderDirective(d.directive, d.directiveColor, d.directiveReason, d.eventRisk, d.dataQuality);
    renderThreeHorizon(d);

    // Regime — wire beacon animation
    renderRegime(d.regime);
    if (d.regime && window.FX) window.FX.setRegimeDot($('regimeDot'), d.regime.regime ?? '');

    // Pillars
    renderPillars(d.pillars);
    if (window.FX) window.FX.staggerElements(document.querySelectorAll('.pillar-row'), 50);

    // Signals fired
    if ($('signalsFired')) $('signalsFired').textContent = `${d.modulesFired ?? '—'}/${Object.keys(d.signals ?? {}).length} signals`;

    // Signal log with stagger
    renderSignalLog(d.signals);

    // Computed at
    if ($('compAt') && d.computedAt) {
      $('compAt').textContent = new Date(d.computedAt).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    }

    // GEX chart + key levels
    if (d.gex) {
      // For futures (ES/NQ), GEX uses a proxy ETF (SPY/QQQ).
      // Use the proxy's own spot for chart filtering so strikes are in range.
      // Scale factor converts proxy ETF prices → futures price space for display.
      const gexSpot  = d.gex.proxySpot ?? d.spot;
      const gexScale = (d.isFutures && d.gex.proxySpot && d.gex.proxySpot > 0)
                       ? d.spot / d.gex.proxySpot : 1;
      const scaleKL  = (v) => v != null ? v * gexScale : null;

      renderGEXChart(d.gex.profile, gexSpot, d.gex.keyLevels);
      renderKeyLevels(d.keyLevels, d.spot);

      // GEX header — gamma flip displayed in instrument price space
      const kl = d.gex.keyLevels;
      const fmtLevel = (v) => {
        if (v == null) return '—';
        const scaled = v * gexScale;
        return gexScale > 5 ? scaled.toFixed(0) : `$${scaled.toFixed(2)}`;
      };

      if ($('gammaFlipVal')) $('gammaFlipVal').textContent = kl?.gammaFlip ? fmtLevel(kl.gammaFlip) : '—';
      if ($('totalGEXVal'))  {
        const t = d.gex.totals?.totGEX;
        $('totalGEXVal').textContent = t != null ? fmtB(t) : '—';
        $('totalGEXVal').style.color = t > 0 ? 'var(--bull)' : 'var(--bear)';
      }
      // Data source badge — shows whether GEX came from CBOE or Yahoo Finance
      const srcEl = $('chainSourceBadge');
      if (srcEl) {
        const src = d.chainSource ?? 'yahoo';
        srcEl.textContent = src === 'cboe' ? 'CBOE' : 'YF';
        srcEl.title       = src === 'cboe'
          ? 'Options data: CBOE CDN (official exchange data, 15-min delayed)'
          : 'Options data: Yahoo Finance (fallback — NR IV solve)';
        srcEl.style.color = src === 'cboe' ? 'var(--bull)' : 'var(--warn)';
      }

      // Stats
      const tot = d.gex.totals;
      setText('statNetGEX',   tot?.totGEX != null ? fmtB(tot.totGEX) : '—', tot?.totGEX);
      setText('statNetDEX',   tot?.totDEX != null ? fmtB(tot.totDEX) : '—', tot?.totDEX);
      setText('statNetVEX',   tot?.totVEX != null ? fmtB(tot.totVEX) : '—', tot?.totVEX);

      if (d.gex.rr25d) {
        const rr = d.gex.rr25d;
        const rrEl = $('statRR');
        if (rrEl) {
          rrEl.textContent = `${(rr.rr * 100).toFixed(2)}% (${rr.skewRegime})`;
          rrEl.style.color = rr.rr > -0.02 ? 'var(--bull)' : rr.rr < -0.06 ? 'var(--bear)' : 'var(--muted)';
        }
      }

      // Right panel stats — all levels in instrument price space
      const proxyLabel = d.gex.proxySymbol ? ` (${d.gex.proxySymbol})` : '';
      if ($('statGEXRegime')) $('statGEXRegime').textContent = (d.gex.totals?.totGEX > 0 ? 'POSITIVE (pinning)' : 'NEGATIVE (amplifying)') + proxyLabel;
      if ($('statMaxPain'))   $('statMaxPain').textContent   = fmtLevel(kl?.maxPain);
      if ($('statCallWall'))  $('statCallWall').textContent  = fmtLevel(kl?.callWall);
      if ($('statPutWall'))   $('statPutWall').textContent   = fmtLevel(kl?.putWall);
    }

    // Hurst / VRP / TSMOM / OFI stats
    if (d.hurst) {
      const h = d.hurst;
      if ($('statHurst')) {
        $('statHurst').textContent = `${h.H.toFixed(3)} (${h.regime})`;
        $('statHurst').style.color = h.H > 0.6 ? 'var(--bull)' : h.H < 0.4 ? 'var(--bear)' : 'var(--neutral)';
      }
    }
    if (d.vrp) {
      const v = d.vrp;
      if ($('statVRP')) {
        $('statVRP').textContent = `${v.vrp?.toFixed(2)}% (${v.interpretation})`;
        $('statVRP').style.color = v.vrp > 3 ? 'var(--bull)' : v.vrp < -2 ? 'var(--bear)' : 'var(--neutral)';
      }
    }
    if (d.tsmom) {
      const t = d.tsmom;
      const shorthand = Object.values(t.signals ?? {}).map(s => {
        return `${s.label ?? '?'}: ${s.rawReturn >= 0 ? '+' : ''}${(s.rawReturn * 100).toFixed(1)}%`;
      }).join(' / ');
      if ($('statTSMOM')) {
        $('statTSMOM').textContent = shorthand || '—';
        $('statTSMOM').style.color = t.tsmomScore > 0 ? 'var(--bull)' : t.tsmomScore < 0 ? 'var(--bear)' : 'var(--neutral)';
      }
    }
    if (d.ofi) {
      if ($('statOFI')) {
        $('statOFI').textContent = `${d.ofi.ofiZscore?.toFixed(2)} (${d.ofi.interpretation})`;
        $('statOFI').style.color = scoreColor(d.ofi.score);
      }
    }

    // Cross-asset
    renderCrossAsset(d.signals?.crossAsset ? { tickerScores: {}, composite: 0 } : null);

    setStatus(true);
    setLastUpdate();

  } catch (err) {
    console.error('[app] bias fetch error:', err);
    setStatus(false);
    const scoreEl = $('gaugeScore');
    if (scoreEl) scoreEl.textContent = 'ERR';
  }

  // Load VIX separately
  loadVIX();
  // Load cross-asset separately
  loadCrossAsset();
}

function setText(id, text, numVal) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  if (numVal != null) el.style.color = scoreColor(numVal);
}

async function loadVIX() {
  try {
    const res  = await fetch('/api/vix');
    const json = await res.json();
    if (!json.ok) return;
    const v = json.data;

    // VIX term stats
    if ($('statVIXTerms')) {
      $('statVIXTerms').textContent = `${v.vix9d?.toFixed(1) ?? '—'} / ${v.vix?.toFixed(1) ?? '—'} / ${v.vix3m?.toFixed(1) ?? '—'}`;
    }
    if ($('statVVIX')) $('statVVIX').textContent = v.vvix?.toFixed(1) ?? '—';
    if ($('statSKEW')) $('statSKEW').textContent = v.skew?.toFixed(1) ?? '—';

    const badge = $('vixRegimeBadge');
    if (badge) {
      badge.textContent = v.contango ? 'CONTANGO' : 'BACKWARDATION';
      badge.className   = `stat-badge ${v.contango ? 'badge-bull' : 'badge-bear'}`;
    }

    renderVIXChart(v.series ?? {});
  } catch {}
}

async function loadCrossAsset() {
  try {
    const res  = await fetch(`/api/momentum?symbol=${currentSymbol}`);
    const json = await res.json();
    if (!json.ok) return;
    const d = json.data;
    renderCrossAsset(d.crossAsset);

    // DEX/VEX/CHEX stats require GEX data — skip here (already in bias)
    // Additional stat fills from momentum data
    if (d.intraday) {
      if ($('statDEXBias'))   $('statDEXBias').textContent  = d.intraday.type ?? '—';
    }
    if (d.pdh) {
      if ($('statExpiry'))    $('statExpiry').textContent = d.pdh.abovePDH ? 'Above PDH' : d.pdh.belowPDL ? 'Below PDL' : 'In Range';
    }
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Restore symbol propagated by the SPA router across page transitions
  if (window._routerSymbol) { currentSymbol = window._routerSymbol; delete window._routerSymbol; }

  // Sync hidden select initial value before dropdown init reads it
  const hiddenSel = document.getElementById('symbolSelect');
  if (hiddenSel) hiddenSel.value = currentSymbol;

  window.initTickerDropdown(value => {
    currentSymbol = value;
    loadData();
  });

  loadData();

  // Auto-refresh every 5 min
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadData, REFRESH_MS);

  // Register cleanup so the SPA router can tear down this page before transition
  window._pageCleanup = () => {
    clearInterval(refreshTimer);
    refreshTimer = null;
  };
}

document.addEventListener('DOMContentLoaded', init);
