'use strict';
// ── Bias Engine — Animation Layer ────────────────────────────────────────────
// Pure DOM animation utilities. No framework. All transform/opacity only.

// ── Score number ticker ───────────────────────────────────────────────────────
// Counts from oldVal to newVal over `duration` ms using an ease-out curve.
function animateScore(el, oldVal, newVal, duration = 550) {
  if (oldVal === newVal) return;
  const start     = performance.now();
  const range     = newVal - oldVal;
  const easeOut   = t => 1 - Math.pow(1 - t, 3);

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const current  = Math.round(oldVal + range * easeOut(progress));
    el.textContent = (current >= 0 ? '+' : '') + current;
    if (progress < 1) requestAnimationFrame(tick);
    else              el.textContent = (newVal >= 0 ? '+' : '') + newVal;
  }
  requestAnimationFrame(tick);
}

// ── Flash animation on any element ───────────────────────────────────────────
function flashEl(el) {
  el.classList.remove('num-updated');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('num-updated');
}

// ── Stagger signal table rows ─────────────────────────────────────────────────
// Call after populating tbody to add staggered entrance animation.
function staggerRows(tbodyEl, baseDelayMs = 20, maxMs = 800) {
  const rows = tbodyEl.querySelectorAll('tr');
  rows.forEach((row, i) => {
    const delay = Math.min(i * baseDelayMs, maxMs);
    row.style.setProperty('--row-delay', delay + 'ms');
    // Reset animation so it reruns when new data arrives
    row.style.animation = 'none';
    void row.offsetWidth;
    row.style.animation = '';
  });
}

// ── Stagger any list of elements ──────────────────────────────────────────────
function staggerElements(els, baseDelayMs = 40) {
  Array.from(els).forEach((el, i) => {
    el.style.animationDelay = (i * baseDelayMs) + 'ms';
  });
}

// ── Gauge glow state ──────────────────────────────────────────────────────────
function setGaugeGlow(score) {
  const wrap = document.querySelector('.gauge-wrap');
  if (!wrap) return;
  wrap.classList.remove('bull-glow', 'bear-glow', 'neutral-glow');
  if      (score >= 20)  wrap.classList.add('bull-glow');
  else if (score <= -20) wrap.classList.add('bear-glow');
  else                   wrap.classList.add('neutral-glow');
}

// ── Gauge energy pulse ring ────────────────────────────────────────────────────
// Fires an expanding ring from the gauge arc when a new score arrives.
function pulseGauge() {
  const wrap = document.querySelector('.gauge-wrap');
  if (!wrap) return;
  wrap.classList.remove('score-pulsing');
  void wrap.offsetWidth;
  wrap.classList.add('score-pulsing');
  setTimeout(() => wrap.classList.remove('score-pulsing'), 800);
}

// ── Score gradient class ──────────────────────────────────────────────────────
function setScoreClass(el, score) {
  el.classList.remove('bull-score', 'bear-score');
  if      (score >= 15)  el.classList.add('bull-score');
  else if (score <= -15) el.classList.add('bear-score');
}

// ── Toast notification ────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('updateToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'updateToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

// ── Mini score bar in signal table ────────────────────────────────────────────
// Wraps a score td to include a tiny bar visualization.
function buildScoreCell(score, weight) {
  const absScore   = Math.abs(score);
  const pct        = Math.min(absScore / 10 * 100, 100);
  const colorClass = score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral';
  const barColor   = score > 0
    ? 'var(--bull)'
    : score < 0 ? 'var(--bear)' : 'var(--muted)';
  const sign       = score >= 0 ? '+' : '';

  return `
    <div class="sig-bar-wrap">
      <span class="sig-score ${colorClass}">${sign}${score.toFixed(1)}</span>
      <div class="sig-mini-bar">
        <div class="sig-mini-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
    </div>`;
}

// ── Regime dot classes ────────────────────────────────────────────────────────
function setRegimeDot(dotEl, regime) {
  dotEl.className = 'regime-dot active';
  if (/bull|low.vol/i.test(regime))      dotEl.classList.add('bull-dot');
  else if (/bear|crash/i.test(regime))   dotEl.classList.add('bear-dot');
  else                                    dotEl.classList.add('warn-dot');
}

// ── Category chip HTML ────────────────────────────────────────────────────────
function catChip(cat) {
  if (!cat) return '';
  const labels = {
    options_gex: 'GEX',
    volatility:  'Vol',
    trend:       'Trend',
    momentum:    'Mom',
    macro:       'Macro',
  };
  const label = labels[cat] || cat;
  return `<span class="cat-chip cat-${cat}">${label}</span>`;
}

// ── Expose globally ───────────────────────────────────────────────────────────
window.FX = {
  animateScore,
  flashEl,
  staggerRows,
  staggerElements,
  setGaugeGlow,
  setScoreClass,
  pulseGauge,
  showToast,
  buildScoreCell,
  setRegimeDot,
  catChip,
};
