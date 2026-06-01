// Bias Gauge — Canvas arc from -100 to +100
// Arc spans 220 degrees. Filled from center outward.
'use strict';

function biasColor(score) {
  if (score >= 60)  return '#34d399'; // emerald-400 strong bull
  if (score >= 20)  return '#6ee7b7'; // emerald-300 bull
  if (score >= -20) return '#71717a'; // zinc-500 neutral
  if (score >= -60) return '#fb7185'; // rose-400 bear
  return '#f43f5e';                   // rose-500 strong bear
}

function labelColor(label) {
  if (label === 'STRONG BULL') return '#34d399';
  if (label === 'BULL')        return '#6ee7b7';
  if (label === 'NEUTRAL')     return '#71717a';
  if (label === 'BEAR')        return '#fb7185';
  return '#f43f5e';
}

// Draw the radial bias gauge onto a canvas element
// score: -100 to +100
function drawGauge(canvas, score, label, confidence, ciLow, ciHigh) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 220;
  const H   = canvas.offsetHeight || 130;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H * 0.90;        // arc center near bottom
  const R  = Math.min(W, H * 1.6) * 0.48;

  // Arc spans 220°: start = 200° (left), end = 340° (right), 0 at bottom
  const startAngle = (200 * Math.PI) / 180;
  const endAngle   = (340 * Math.PI) / 180;
  const totalArc   = endAngle - startAngle; // = 140° in radians = 2.44 rad

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, R, startAngle, endAngle);
  ctx.strokeStyle = '#27272a';
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Confidence interval ghost arc
  if (ciLow !== null && ciHigh !== null) {
    const ciStartAngle = startAngle + ((ciLow + 100) / 200) * totalArc;
    const ciEndAngle   = startAngle + ((ciHigh + 100) / 200) * totalArc;
    ctx.beginPath();
    ctx.arc(cx, cy, R, ciStartAngle, ciEndAngle);
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'butt';
    ctx.stroke();
  }

  // Zero marker (center, neutral position)
  const zeroA = startAngle + (100 / 200) * totalArc;
  ctx.beginPath();
  ctx.moveTo(cx + (R - 6) * Math.cos(zeroA), cy + (R - 6) * Math.sin(zeroA));
  ctx.lineTo(cx + (R + 6) * Math.cos(zeroA), cy + (R + 6) * Math.sin(zeroA));
  ctx.strokeStyle = '#52525b';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Filled arc for score
  const clampedScore = Math.max(-100, Math.min(100, score || 0));
  const scoreAngle   = startAngle + ((clampedScore + 100) / 200) * totalArc;

  // Draw from zero to score (fill from center)
  const zeroAngle = startAngle + (100 / 200) * totalArc;
  const arcFrom   = clampedScore >= 0 ? zeroAngle   : scoreAngle;
  const arcTo     = clampedScore >= 0 ? scoreAngle   : zeroAngle;

  if (Math.abs(clampedScore) > 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, arcFrom, arcTo);
    ctx.strokeStyle = biasColor(clampedScore);
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'round';
    ctx.stroke();
  }

  // Needle
  const needleA = scoreAngle;
  const nInner  = R - 16;
  const nOuter  = R + 4;
  ctx.beginPath();
  ctx.moveTo(cx + nInner * Math.cos(needleA), cy + nInner * Math.sin(needleA));
  ctx.lineTo(cx + nOuter * Math.cos(needleA), cy + nOuter * Math.sin(needleA));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Tick marks at -100, -60, -20, 0, +20, +60, +100
  const ticks = [-100, -60, -20, 0, 20, 60, 100];
  ticks.forEach(t => {
    const a = startAngle + ((t + 100) / 200) * totalArc;
    const isZero = t === 0;
    ctx.beginPath();
    ctx.moveTo(cx + (R - 14) * Math.cos(a), cy + (R - 14) * Math.sin(a));
    ctx.lineTo(cx + (R - 7) * Math.cos(a),  cy + (R - 7) * Math.sin(a));
    ctx.strokeStyle = isZero ? '#71717a' : '#3f3f46';
    ctx.lineWidth   = isZero ? 2 : 1;
    ctx.stroke();
  });

  // Confidence ring (thin inner arc showing confidence level)
  const confArc = totalArc * (confidence || 0);
  const confStart = startAngle + (totalArc - confArc) / 2; // centered
  ctx.beginPath();
  ctx.arc(cx, cy, R - 18, confStart, confStart + confArc);
  ctx.strokeStyle = biasColor(clampedScore) + '55'; // 33% opacity
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

// Update DOM elements alongside the canvas
function updateGauge(score, label, confidence, ciLow, ciHigh) {
  const canvas = document.getElementById('biasCanvas');
  if (!canvas) return;

  // Draw
  drawGauge(canvas, score, label, confidence, ciLow, ciHigh);

  // DOM
  const scoreEl = document.getElementById('gaugeScore');
  const labelEl = document.getElementById('gaugeLabel');
  const ciEl    = document.getElementById('gaugeCI');
  const confEl  = document.getElementById('gaugeConf');

  if (scoreEl) {
    // Always set the final value — FX ticker in app.js will animate over it
    // for subsequent updates (it starts from the previous score, overwriting textContent
    // during the animation run). This ensures the score always shows on first load.
    scoreEl.textContent = score >= 0 ? `+${score}` : `${score}`;
    if (!window.FX) scoreEl.style.color = biasColor(score);
  }
  if (labelEl) {
    labelEl.textContent = label || '—';
    labelEl.style.color = labelColor(label);
  }
  if (ciEl)   ciEl.textContent   = `90% CI: ${ciLow ?? '—'} to ${ciHigh ?? '—'}`;
  if (confEl) confEl.textContent = `Confidence: ${Math.round((confidence ?? 0) * 100)}%`;
}

window.drawGauge    = drawGauge;
window.updateGauge  = updateGauge;
window.biasColor    = biasColor;
window.labelColor   = labelColor;
