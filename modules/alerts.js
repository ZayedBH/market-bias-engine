'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');

// Ensure data directory exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveAlerts(alerts) {
  // Keep the last 1000 alerts on disk
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts.slice(-1000), null, 2));
}

// In-memory tracking of previous bias per symbol
const prevBias = {};

// ── Alert Rules ───────────────────────────────────────────────────────────────
function checkAlerts(symbol, biasResult) {
  if (!biasResult || biasResult.composite == null) return [];

  const curr = biasResult.composite;
  const prev = prevBias[symbol];
  const newAlerts = [];

  if (prev !== undefined) {
    // 1. Bias flip: zero crossing
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
      newAlerts.push({
        id:       `${Date.now()}_flip_${symbol}`,
        type:     'BIAS_FLIP',
        symbol,
        severity: 'HIGH',
        message:  `Bias flipped ${prev > 0 ? 'BULL→BEAR' : 'BEAR→BULL'} (${prev > 0 ? '+' : ''}${Math.round(prev)} → ${curr > 0 ? '+' : ''}${Math.round(curr)})`,
        prev:     Math.round(prev),
        curr:     Math.round(curr),
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Large shift: > 25 points in one interval
    const shift = curr - prev;
    if (Math.abs(shift) > 25) {
      newAlerts.push({
        id:       `${Date.now()}_shift_${symbol}`,
        type:     'LARGE_SHIFT',
        symbol,
        severity: 'MEDIUM',
        message:  `Large bias shift: ${Math.round(prev)} → ${Math.round(curr)} (${shift > 0 ? '+' : ''}${Math.round(shift)} pts)`,
        prev:     Math.round(prev),
        curr:     Math.round(curr),
        shift:    Math.round(shift),
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Extreme reading: newly entered ±70
    if (Math.abs(curr) >= 70 && Math.abs(prev) < 70) {
      newAlerts.push({
        id:       `${Date.now()}_extreme_${symbol}`,
        type:     'EXTREME_READING',
        symbol,
        severity: 'MEDIUM',
        message:  `${symbol} entered extreme ${curr > 0 ? 'BULLISH' : 'BEARISH'} territory: ${curr > 0 ? '+' : ''}${Math.round(curr)}`,
        curr:     Math.round(curr),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 4. Regime change alert
  if (biasResult.regime?.regime) {
    const prevRegime = prevBias[`${symbol}_regime`];
    const currRegime = biasResult.regime.regime;
    if (prevRegime && prevRegime !== currRegime) {
      newAlerts.push({
        id:       `${Date.now()}_regime_${symbol}`,
        type:     'REGIME_CHANGE',
        symbol,
        severity: 'HIGH',
        message:  `HMM Regime changed: ${prevRegime.replace(/_/g,' ')} → ${currRegime.replace(/_/g,' ')} (conf: ${(biasResult.regime.confidence * 100).toFixed(0)}%)`,
        prevRegime,
        currRegime,
        confidence: biasResult.regime.confidence,
        timestamp: new Date().toISOString(),
      });
    }
    prevBias[`${symbol}_regime`] = currRegime;
  }

  // 5. GEX regime sign change
  if (biasResult.gex?.gexRegime) {
    const prevGEXReg = prevBias[`${symbol}_gex`];
    const currGEXReg = biasResult.gex.gexRegime;   // caller passes gex.gexRegime.gexRegime
    if (prevGEXReg && prevGEXReg !== currGEXReg) {
      newAlerts.push({
        id:       `${Date.now()}_gex_${symbol}`,
        type:     'GEX_FLIP',
        symbol,
        severity: 'MEDIUM',
        message:  `GEX flipped: ${prevGEXReg} → ${currGEXReg}`,
        prevGEXReg,
        currGEXReg,
        timestamp: new Date().toISOString(),
      });
    }
    prevBias[`${symbol}_gex`] = currGEXReg;
  }

  prevBias[symbol] = curr;

  if (newAlerts.length) {
    const existing = loadAlerts();
    saveAlerts([...existing, ...newAlerts]);
    newAlerts.forEach(a =>
      console.log(`[ALERT] [${a.severity}] ${a.type} — ${a.message}`)
    );
  }

  return newAlerts;
}

// ── Query interface ───────────────────────────────────────────────────────────
function getAlerts({ symbol = null, type = null, since = null, limit = 100 } = {}) {
  let alerts = loadAlerts();

  if (symbol) alerts = alerts.filter(a => a.symbol === symbol);
  if (type)   alerts = alerts.filter(a => a.type   === type);
  if (since)  alerts = alerts.filter(a => a.timestamp >= since);

  return alerts.slice(-limit).reverse(); // newest first
}

function clearAlerts(symbol = null) {
  if (symbol) {
    const all = loadAlerts().filter(a => a.symbol !== symbol);
    saveAlerts(all);
  } else {
    saveAlerts([]);
  }
}

module.exports = { checkAlerts, getAlerts, clearAlerts };
