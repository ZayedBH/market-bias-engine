'use strict';

// ── Economic Calendar ─────────────────────────────────────────────────────────
// Sources:
//   Lucca & Moench (2015) "The Pre-FOMC Announcement Drift"
//   Ni, Pearson & Poteshman (2005) "Stock Price Clustering on Option Expiration Dates"
//   Ogden (1990) "Turn-of-Month Evaluations of Liquid Profits and Stock Returns"
//
// Events tracked:
//   FOMC  — hard-coded decision dates (Fed calendar published a year ahead)
//   CPI   — BLS release dates (published ~6 months ahead)
//   NFP   — first Friday of each month (Bureau of Labor Statistics)
//   OPEX  — 3rd Friday monthly / every Friday weekly / quad-witch quarterly

// ── FOMC decision dates (ET noon = 18:00 UTC, statement released ~14:00 ET) ──
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
const FOMC_DATES = [
  // 2025
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  // 2026
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  // 2027
  '2027-01-27', '2027-03-17', '2027-05-05', '2027-06-16',
  '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
];

// ── CPI release dates (BLS, 8:30 AM ET) ──────────────────────────────────────
// Source: bls.gov/schedule/news_release/cpi.htm
const CPI_DATES = [
  // 2025
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10',
  '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12',
  '2025-09-10', '2025-10-15', '2025-11-13', '2025-12-10',
  // 2026
  '2026-01-14', '2026-02-11', '2026-03-11', '2026-04-08',
  '2026-05-13', '2026-06-10', '2026-07-15', '2026-08-12',
  '2026-09-09', '2026-10-14', '2026-11-12', '2026-12-09',
];

// ── First Friday of a given month = NFP release ───────────────────────────────
function firstFridayOfMonth(year, month) { // month: 0-indexed
  const dayOfWeek = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const daysToFri = (5 - dayOfWeek + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + daysToFri));
}

// ── Third Friday of a given month = monthly OPEX ─────────────────────────────
function thirdFridayOfMonth(year, month) {
  const dayOfWeek = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstFri  = (5 - dayOfWeek + 7) % 7; // days to first Friday from 1st
  return new Date(Date.UTC(year, month, 1 + firstFri + 14));
}

// ── Next Friday at or after a given UTC date ──────────────────────────────────
function nextFriday(fromDate) {
  const d   = new Date(fromDate);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day <= 5 ? (5 - day) : 6; // if already Friday diff=0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
}

// ── Days between two Unix timestamps ─────────────────────────────────────────
function daysBetween(ts1, ts2) { return (ts2 - ts1) / 86400; }

// ── Main calendar query ───────────────────────────────────────────────────────
// Returns a rich context object for all scheduled events relative to nowTs (seconds)
function getCalendarContext(nowTs) {
  const now = new Date(nowTs * 1000);
  const yr  = now.getUTCFullYear();
  const mo  = now.getUTCMonth(); // 0-indexed

  // Parse 'YYYY-MM-DD' to Unix seconds at 19:00 UTC (2 PM ET standard, 3 PM EDT)
  const parseDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 19) / 1000;
  };

  // ── FOMC ─────────────────────────────────────────────────────────────────
  const fomcTimestamps = FOMC_DATES.map(parseDate);
  let nextFomc = null, prevFomc = null;
  for (const ts of fomcTimestamps) {
    if (ts > nowTs && (!nextFomc || ts < nextFomc)) nextFomc = ts;
    if (ts <= nowTs && (!prevFomc || ts > prevFomc)) prevFomc = ts;
  }
  const daysToFomc    = nextFomc ? daysBetween(nowTs, nextFomc) : 999;
  const daysSinceFomc = prevFomc ? daysBetween(prevFomc, nowTs) : 999;
  const postFomcH     = daysSinceFomc * 24;
  // Lucca-Moench (2015): positive equity drift in 24h BEFORE FOMC decision
  const inPreFomcWindow   = daysToFomc >= 0 && daysToFomc <= 1.0;
  // Immediate post-FOMC (0-4h): IV collapse → vol-crush relief bounce (Lucca-Moench 2015)
  const inPostFomcCrush   = postFomcH >= 0 && postFomcH < 4;
  // NOTE: a "4-24h post-FOMC fade" field was removed — not from the source paper.

  // ── CPI ──────────────────────────────────────────────────────────────────
  const cpiTimestamps = CPI_DATES.map(parseDate);
  let nextCpi = null, prevCpi = null;
  for (const ts of cpiTimestamps) {
    if (ts > nowTs && (!nextCpi || ts < nextCpi)) nextCpi = ts;
    if (ts <= nowTs && (!prevCpi || ts > prevCpi)) prevCpi = ts;
  }
  const daysToCpi    = nextCpi ? daysBetween(nowTs, nextCpi) : 999;
  const daysSinceCpi = prevCpi ? daysBetween(prevCpi, nowTs) : 999;
  const inPreCpiWindow  = daysToCpi >= 0 && daysToCpi <= 1.0;
  const inPostCpiCrush  = daysSinceCpi * 24 < 6; // within 6h of release

  // ── NFP (first Friday of each month, 8:30 AM ET) ─────────────────────────
  // Check current and next month — must roll year when month overflows December.
  const nfpNextMo    = mo + 1;
  const nfpThisMonth = firstFridayOfMonth(yr, mo);
  const nfpNextMonth = firstFridayOfMonth(nfpNextMo > 11 ? yr + 1 : yr, nfpNextMo % 12);
  const nfpThisTs    = nfpThisMonth.getTime() / 1000 + 12.5 * 3600; // 8:30 AM ET ≈ 12:30 UTC
  const nfpNextTs    = nfpNextMonth.getTime() / 1000 + 12.5 * 3600;
  const daysToNFP    = nfpThisTs > nowTs
    ? daysBetween(nowTs, nfpThisTs)
    : daysBetween(nowTs, nfpNextTs);
  const inPreNFPWindow = daysToNFP >= 0 && daysToNFP <= 1.0;

  // ── Monthly OPEX (3rd Friday, 4:00 PM ET close) ───────────────────────────
  // Must roll year when month overflows December.
  const opexNextMo     = mo + 1;
  const monthlyOpexD   = thirdFridayOfMonth(yr, mo);
  const monthlyOpexTs  = monthlyOpexD.getTime() / 1000 + 20 * 3600; // 4 PM ET = 20 UTC
  const nextMonthlyOpexTs = monthlyOpexTs > nowTs
    ? monthlyOpexTs
    : thirdFridayOfMonth(opexNextMo > 11 ? yr + 1 : yr, opexNextMo % 12).getTime() / 1000 + 20 * 3600;
  const daysToMonthlyOpex = daysBetween(nowTs, nextMonthlyOpexTs);
  // Days since previous OPEX: next - ~28 days gives a reasonable approximation
  const prevMonthlyOpexTs = nextMonthlyOpexTs - 28 * 86400;
  const daysSinceMonthlyOpex = daysBetween(prevMonthlyOpexTs, nowTs);

  // ── Weekly OPEX (next Friday 4 PM ET) ────────────────────────────────────
  const nextFri       = nextFriday(now);
  const weeklyOpexTs  = nextFri.getTime() / 1000 + 20 * 3600;
  const daysToWeeklyOpex = daysBetween(nowTs, weeklyOpexTs);

  // ── Quad-witching: 3rd Friday of Mar/Jun/Sep/Dec ─────────────────────────
  const isQuadMonth  = [2, 5, 8, 11].includes(mo); // 0-indexed
  const isNearQuad   = isQuadMonth && daysToMonthlyOpex <= 5.5; // within OPEX week
  const isQuadDay    = isQuadMonth && daysToMonthlyOpex <= 0.5;

  // ── Turn-of-month (Ogden 1990) ────────────────────────────────────────────
  // Institutional pension/mutual fund rebalancing flows create positive drift
  // in the last 3 trading days of month + first 2 trading days of next month
  const dayOfMonth   = now.getUTCDate();
  const daysInMonth  = new Date(Date.UTC(yr, mo + 1, 0)).getUTCDate();
  const daysToEnd    = daysInMonth - dayOfMonth;
  const inTurnOfMonth = daysToEnd <= 3 || dayOfMonth <= 2;
  // Strength: strongest on last day and first day of month
  const tomStrength  = (daysToEnd === 0 || dayOfMonth === 1) ? 3
                     : (daysToEnd <= 1 || dayOfMonth <= 2)   ? 2
                     : 1;
  const tomScore     = inTurnOfMonth ? tomStrength : 0;

  // ── Day-of-week seasonal bias ─────────────────────────────────────────────
  // Based on empirical S&P 500 return-by-weekday literature
  // Monday: typically weakest (weekend risk unwind, post-news repricing)
  // Wednesday: midweek strength (institutional rebalancing)
  // Friday: mixed (window dressing vs weekend risk reduction)
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon...5=Fri, 6=Sat
  const DOW_BIAS = { 1: -0.5, 2: 0.3, 3: 0.5, 4: 0.2, 5: 0.0 };
  const dowBias  = DOW_BIAS[dow] ?? 0;

  return {
    // FOMC
    daysToFomc,
    daysSinceFomc,
    inPreFomcWindow,
    inPostFomcCrush,
    // CPI
    daysToCpi,
    daysSinceCpi,
    inPreCpiWindow,
    inPostCpiCrush,
    // NFP
    daysToNFP,
    inPreNFPWindow,
    // OPEX
    daysToMonthlyOpex,
    daysSinceMonthlyOpex,
    daysToWeeklyOpex,
    isQuadMonth,
    isNearQuad,
    isQuadDay,
    // Calendar
    inTurnOfMonth,
    tomScore,
    dow,
    dowBias,
    dayOfMonth,
    daysInMonth,
  };
}

module.exports = { getCalendarContext, thirdFridayOfMonth, firstFridayOfMonth };
