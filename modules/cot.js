'use strict';

const https  = require('https');
const zlib   = require('zlib');

// ── Minimal ZIP parser using Node.js built-in zlib ────────────────────────────
// No external dependencies — pure Node.js
function parseZipBuffer(buf) {
  const files = [];
  let i = 0;
  while (i < buf.length - 30) {
    // Local file header signature: PK\x03\x04
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
      const compression   = buf.readUInt16LE(i + 8);
      const compressedSz  = buf.readUInt32LE(i + 18);
      const uncompressedSz = buf.readUInt32LE(i + 22);
      const filenameLen   = buf.readUInt16LE(i + 26);
      const extraLen      = buf.readUInt16LE(i + 28);
      const filename      = buf.slice(i + 30, i + 30 + filenameLen).toString('utf8');
      const dataOffset    = i + 30 + filenameLen + extraLen;
      const compData      = buf.slice(dataOffset, dataOffset + compressedSz);
      files.push({ filename, compression, compData, compressedSz, uncompressedSz });
      i = dataOffset + compressedSz;
    } else {
      i++;
    }
  }
  return files;
}

function decompressEntry(entry) {
  return new Promise((resolve, reject) => {
    if (entry.compression === 0) {
      resolve(entry.compData.toString('utf8'));
    } else if (entry.compression === 8) {
      zlib.inflateRaw(entry.compData, (err, result) => {
        if (err) reject(err);
        else resolve(result.toString('utf8'));
      });
    } else {
      reject(new Error(`Unsupported ZIP compression method: ${entry.compression}`));
    }
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MarketBiasEngine/2.0)',
        'Accept': '*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('COT fetch timeout')); });
  });
}

// ── Parse CFTC TFF CSV ────────────────────────────────────────────────────────
// "Traders in Financial Futures" (TFF) report — NOT the legacy COT report.
// The TFF uses different trader categories than the legacy report:
//   Lev_Money   = Leveraged Money (hedge funds, CTAs)  ← the "speculative" camp
//   Asset_Mgr   = Asset Manager / Institutional         ← long-only funds
//   Dealer      = Dealer/Intermediary (banks)           ← smart-money proxy
// There is NO "NonComm" column in TFF data.
const ES_CODE    = '13874A';
const NQ_CODE    = '20974+'; // NASDAQ-100 Consolidated (E-mini + full-size) CFTC TFF code
const FIELD_COLS = {
  date:       'Report_Date_as_YYYY-MM-DD',
  dateAlt:    'As_of_Date_In_Form_YYMMDD',
  code:       'CFTC_Contract_Market_Code',
  // Leveraged Money = hedge funds / CTAs (the speculative camp)
  levLong:    'Lev_Money_Positions_Long_All',
  levShort:   'Lev_Money_Positions_Short_All',
  levSpread:  'Lev_Money_Positions_Spread_All',
  // Asset Manager = institutional (long-only, trend followers)
  amLong:     'Asset_Mgr_Positions_Long_All',
  amShort:    'Asset_Mgr_Positions_Short_All',
  // Dealer = intermediaries (contra-trend, smart-money proxy)
  dealLong:   'Dealer_Positions_Long_All',
  dealShort:  'Dealer_Positions_Short_All',
  // Change columns for momentum
  chgLevLong: 'Change_in_Lev_Money_Long_All',
  chgLevShort:'Change_in_Lev_Money_Short_All',
};

function parseCSV(csvText, code = ES_CODE) {
  const lines  = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const idx    = {};
  header.forEach((h, i) => { idx[h] = i; });

  // Validate that we have the expected TFF columns
  const hasTFF = idx['Lev_Money_Positions_Long_All'] !== undefined;
  if (!hasTFF) {
    console.warn('[COT] CSV does not appear to be TFF format — missing Lev_Money columns');
  }

  const getInt = (cols, colName) => {
    const i = idx[colName];
    if (i === undefined) return 0;
    return parseInt(cols[i], 10) || 0;
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols    = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
    const codeIdx = idx['CFTC_Contract_Market_Code'];
    if (codeIdx === undefined) continue;
    const rowCode = cols[codeIdx];
    if (!rowCode || !rowCode.includes(code)) continue;

    const dateStr = cols[idx['Report_Date_as_YYYY-MM-DD']] ||
                    cols[idx['As_of_Date_In_Form_YYMMDD']] || '';
    if (!dateStr) continue;

    // TFF categories:
    const levLong    = getInt(cols, 'Lev_Money_Positions_Long_All');
    const levShort   = getInt(cols, 'Lev_Money_Positions_Short_All');
    const levSpread  = getInt(cols, 'Lev_Money_Positions_Spread_All');
    const amLong     = getInt(cols, 'Asset_Mgr_Positions_Long_All');
    const amShort    = getInt(cols, 'Asset_Mgr_Positions_Short_All');
    const dealLong   = getInt(cols, 'Dealer_Positions_Long_All');
    const dealShort  = getInt(cols, 'Dealer_Positions_Short_All');
    const openInt    = getInt(cols, 'Open_Interest_All');

    // netSpec = Leveraged Money net (hedge funds + CTAs = the speculative camp)
    // netComm = Dealer net (contra-trend smart-money proxy)
    // netAM   = Asset Manager net (institutional trend followers)
    const netSpec = levLong - levShort;
    const netComm = dealLong - dealShort;
    const netAM   = amLong - amShort;

    rows.push({
      date: dateStr,
      levLong, levShort, levSpread,
      amLong,  amShort,
      dealLong, dealShort,
      openInt,
      // Legacy aliases kept for computeCOTIndex compatibility:
      ncLong:  levLong,
      ncShort: levShort,
      cLong:   dealLong,
      cShort:  dealShort,
      netSpec,
      netComm,
      netAM,
    });
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// ── COT Index ─────────────────────────────────────────────────────────────────
// COT Index = (Current - Min) / (Max - Min) × 100 over rolling 3-year window
// Source: Bessembinder & Seguin (1992), De Roon et al. (2000)
function computeCOTIndex(rows, lookbackWeeks = 156) { // 156 weeks = 3 years
  if (rows.length < 10) return null;

  const recent = rows.slice(-lookbackWeeks);
  const netSpecs = recent.map(r => r.netSpec);
  const min = Math.min(...netSpecs);
  const max = Math.max(...netSpecs);
  const range = max - min;

  const current = netSpecs[netSpecs.length - 1];
  const cotIndex = range > 0 ? ((current - min) / range) * 100 : 50;

  // Signal: high COT Index = specs extremely long = CONTRARIAN BEARISH
  let signal = 0, label = 'NEUTRAL';
  if (cotIndex > 85)      { signal = -1;   label = 'EXTREME_SPEC_LONG';  }
  else if (cotIndex > 65) { signal = -0.5; label = 'ELEVATED_SPEC_LONG'; }
  else if (cotIndex < 15) { signal = +1;   label = 'EXTREME_SPEC_SHORT'; }
  else if (cotIndex < 35) { signal = +0.5; label = 'DEPRESSED_SPEC_LONG';}

  const magnitude = Math.abs(cotIndex - 50) / 50;
  const score = Math.max(-10, Math.min(10, signal * magnitude * 10));

  // 4-week change in net spec position (momentum of positioning)
  const prev4w = rows.length >= 5 ? rows[rows.length - 5].netSpec : current;
  const posChange = current - prev4w;

  // Dealer (market maker / intermediary) — in TFF, dealers are NOT traditional "commercials".
  // Dealers net short = they are providing liquidity to buyers (bullish flow).
  // Dealers net long = they are absorbing sells from longs (bearish flow).
  // So dealer net SHORT is actually bullish (they're short because they sold to buyers).
  const last       = rows[rows.length - 1];
  const commNet    = last.netComm;
  // commSignal: dealer net SHORT = bullish (positive signal), dealer net LONG = bearish
  const commSignal = commNet < 0 ? 1 : -1;

  // Asset Manager positioning (institutional trend followers, generally bullish)
  const amNet    = last.netAM ?? 0;
  const amSignal = amNet > 0 ? 1 : -1; // AM net long = institutional demand = bullish

  // Composite COT score: blend lev-money contrarian + AM trend confirmation
  // If AM also net short (unusual), that reduces the bullish signal
  const amBoost = amSignal * 0.3 * magnitude; // AM add up to ±30% weight
  const compositeScore = Math.max(-10, Math.min(10,
    score + amBoost * 10
  ));

  return {
    cotIndex,
    current,
    netSpec:      current,
    netComm:      commNet,
    netAM:        amNet,
    posChange,
    min,
    max,
    signal,
    label,
    magnitude,
    score,
    compositeScore,
    commSignal,
    amSignal,
    lastDate: last.date,
    weeks:    rows.length,
  };
}

// ── Main fetch + compute function ─────────────────────────────────────────────
// Per-instrument cache — ES and NQ have separate COT data
const cotCaches   = {};
const cotCacheTimes = {};
const COT_TTL = 12 * 60 * 60 * 1000; // refresh every 12 hours

async function fetchCOTSignal(code = ES_CODE) {
  const now = Date.now();
  if (cotCaches[code] && now - cotCacheTimes[code] < COT_TTL) return cotCaches[code];

  const year = new Date().getFullYear();
  const prevYear = year - 1;

  // Try current and previous year ZIPs
  let allRows = [];
  for (const yr of [prevYear, year]) {
    const url = `https://www.cftc.gov/files/dea/history/fut_fin_txt_${yr}.zip`;
    try {
      console.log(`[COT] fetching ${yr} data from CFTC…`);
      const buf   = await fetchBuffer(url);
      const files = parseZipBuffer(buf);

      for (const file of files) {
        if (!file.filename.toLowerCase().endsWith('.txt') && !file.filename.toLowerCase().endsWith('.csv')) continue;
        const text  = await decompressEntry(file);
        const rows  = parseCSV(text, code);
        if (rows.length > 0) {
          allRows = allRows.concat(rows);
          console.log(`[COT] parsed ${rows.length} rows from ${file.filename} (${yr})`);
          break;
        }
      }
    } catch (e) {
      console.warn(`[COT] ${yr} zip failed: ${e.message}`);
    }
  }

  if (allRows.length === 0) {
    return { available: false, error: 'No COT data parsed', fetchedAt: new Date().toISOString() };
  }

  // Deduplicate by date and sort
  const seen = new Set();
  const deduped = allRows.filter(r => seen.has(r.date) ? false : seen.add(r.date));
  deduped.sort((a, b) => a.date.localeCompare(b.date));

  const result = computeCOTIndex(deduped, 156);

  // Debug log to confirm values are non-zero
  const last = deduped[deduped.length - 1];
  console.log(`[COT] ${code} last row: ${last.date} | levL=${last.levLong} levS=${last.levShort} netSpec=${last.netSpec} | dealL=${last.dealLong} dealS=${last.dealShort} netComm=${last.netComm} | OI=${last.openInt}`);
  console.log(`[COT] ${code} index=${result.cotIndex?.toFixed(1)} label=${result.label} score=${result.score?.toFixed(2)}`);

  // CFTC releases with a 3-day lag (Friday data → Tuesday release).
  // If lastDate is > 10 days old, something is wrong — warn and mark stale.
  const lastDateMs = new Date(result.lastDate + 'T12:00:00Z').getTime();
  const ageDays    = (Date.now() - lastDateMs) / 86_400_000;
  if (ageDays > 10) {
    console.warn(`[COT] ${code} data is ${ageDays.toFixed(0)} days old (last: ${result.lastDate}) — STALE`);
  }

  const output = {
    available: true,
    ...result,
    stale:     ageDays > 10,
    ageDays:   Math.round(ageDays),
    recentRows: deduped.slice(-12).map(r => ({
      date:    r.date,
      netSpec: r.netSpec,
      netComm: r.netComm,
      netAM:   r.netAM ?? 0,
      levLong: r.levLong,
      levShort: r.levShort,
    })),
    fetchedAt: new Date().toISOString(),
  };

  cotCaches[code]   = output;
  cotCacheTimes[code] = now;
  return output;
}

module.exports = { fetchCOTSignal, computeCOTIndex, parseCSV, ES_CODE, NQ_CODE };
