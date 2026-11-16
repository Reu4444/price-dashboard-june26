// "Stocks that resist the market": backtest, then today's list.
// A stock resists when, over the last 40 sessions, it held up better than the S&P 500 on its down days (S&P -0.5% or worse)
// AND did at least as well on its up days (S&P +0.5% or better), while staying within 15% of its 52-week high.
// Test: every 20 sessions over 10 years (US stocks of the dashboard, today's list: survivorship bias), what did each group do
// over the next 63 sessions (3 months) vs the average stock? Split by market: all dates, and dates when the S&P 500 was 8%+ under its 1-year high.

const W = 40, STEP = 20, FWD = 63, FWD6 = 126, DN = -0.005, UP = 0.005, NEAR = 0.85;
// markets: every date; S&P 8%+, 10%+ and 15%+ under its 1-year high (deeper corrections)
const REGS = { all: () => true, correction: dd => dd >= 0.08, dd10: dd => dd >= 0.10, dd15: dd => dd >= 0.15 };

const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const v = a.slice().sort((x, y) => x - y), k = v.length; return k % 2 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2; };
const pctRank = vals => { const idx = vals.map((v, i) => [v, i]).filter(x => x[0] != null).sort((a, b) => a[0] - b[0]), out = new Array(vals.length).fill(null);
  idx.forEach(([, i], k) => { out[i] = idx.length > 1 ? k / (idx.length - 1) : 0.5; }); return out; };

// spy: [{ t, a }]; stocks: Map tk -> [{ t, a }]
export function resist(spy, stocks) {
  const day = t => Math.floor(t / 864e5), D = spy.map(x => day(x.t)), pos = new Map(D.map((d, i) => [d, i])), n = D.length;
  const M = spy.map(x => x.a);
  // each stock on the S&P dates (null when it did not trade that day)
  const tks = [...stocks.keys()], P = tks.map(tk => { const a = new Array(n).fill(null); for (const x of stocks.get(tk)) { const i = pos.get(day(x.t)); if (i != null) a[i] = x.a; } return a; });
  const ret = (a, i) => a[i] != null && a[i - 1] != null && a[i - 1] > 0 ? a[i] / a[i - 1] - 1 : null;
  const hi252 = (a, i) => { let h = 0; for (let k = Math.max(0, i - 251); k <= i; k++) if (a[k] > h) h = a[k]; return h; };
  // the measures of every stock at session i: down-day and up-day returns vs the S&P, near its high, classic RS score
  const at = i => {
    const dn = [], up = []; for (let k = i - W + 1; k <= i; k++) { const m = ret(M, k); if (m == null) continue; if (m <= DN) dn.push(k); else if (m >= UP) up.push(k); }
    if (dn.length < 4 || up.length < 4) return null;   // a calm stretch: nothing to measure
    let pk = i; for (let k = Math.max(0, i - 251); k <= i; k++) if (M[k] > M[pk]) pk = k;   // the S&P's 1-year high: the start of the fall
    const rows = P.map(a => {
      if (a[i] == null || a[i - W] == null || a[i - 252] == null) return null;
      const rel = days => { const v = days.map(k => { const s = ret(a, k), m = ret(M, k); return s == null || m == null ? null : s - m; }).filter(x => x != null); return v.length >= days.length * 0.8 ? mean(v) : null; };
      const r = (k) => a[i - k] > 0 ? a[i] / a[i - k] - 1 : null;
      const rs = [63, 126, 189, 252].map(r); const rsS = rs.every(x => x != null) ? 0.4 * rs[0] + 0.2 * rs[1] + 0.2 * rs[2] + 0.2 * rs[3] : null;
      const held = pk < i && a[pk] > 0 ? a[i] / a[pk] - 1 : null;   // its move since the S&P's high (how well it held during the fall)
      return { dn: rel(dn), up: rel(up), near: a[i] / hi252(a, i) >= NEAR, rsS, held };
    });
    const rDn = pctRank(rows.map(x => x && x.dn)), rUp = pctRank(rows.map(x => x && x.up)), rRs = pctRank(rows.map(x => x && x.rsS)), rHd = pctRank(rows.map(x => x && x.held));
    return rows.map((x, j) => x && x.dn != null && x.up != null ? { ...x, pDn: rDn[j], pUp: rUp[j], pHeld: rHd[j], rs: rRs[j] == null ? null : Math.round(rRs[j] * 98) + 1 } : null);
  };
  // a resister: top 30% on down days, top half on up days, within 15% of its 52-week high
  const isRes = x => x && x.pDn >= 0.7 && x.pUp >= 0.5 && x.near;
  const groups = { all: () => true, res: isRes, rs90: x => x && x.rs >= 90, res_rs90: x => isRes(x) && x.rs >= 90, rs90_notres: x => x && x.rs >= 90 && !isRes(x), dnOnly: x => x && x.pDn >= 0.7 && x.near,
    held20: x => x && x.pHeld >= 0.8, held20_rs90: x => x && x.pHeld >= 0.8 && x.rs >= 90, held20_near: x => x && x.pHeld >= 0.8 && x.near, worst20: x => x && x.pHeld != null && x.pHeld <= 0.2 };   // held20 = the 20% that fell least (or rose most) since the S&P's high
  const acc = {}, acc6 = {}, nDates = {}; for (const reg of Object.keys(REGS)) { acc[reg] = {}; acc6[reg] = {}; nDates[reg] = 0; for (const g of Object.keys(groups)) { acc[reg][g] = { ex: [], years: {} }; acc6[reg][g] = { ex: [], years: {} }; } }
  let dates = 0, corrDates = 0;
  for (let i = 260; i + FWD < n; i += STEP) {
    const xs = at(i); if (!xs) continue; dates++;
    const fwd = P.map(a => a[i] > 0 && a[i + FWD] > 0 ? a[i + FWD] / a[i] - 1 : null), avg = mean(fwd.filter(v => v != null)); if (avg == null) continue;
    const fwd6 = i + FWD6 < n ? P.map(a => a[i] > 0 && a[i + FWD6] > 0 ? a[i + FWD6] / a[i] - 1 : null) : null, avg6 = fwd6 ? mean(fwd6.filter(v => v != null)) : null;
    const dd = 1 - M[i] / hi252(M, i), corr = dd >= 0.08; if (corr) corrDates++; for (const [reg, f] of Object.entries(REGS)) if (f(dd)) nDates[reg]++;
    const yr = new Date(D[i] * 864e5).getUTCFullYear();
    for (const [g, f] of Object.entries(groups)) { const ex = [], ex6 = []; xs.forEach((x, j) => { if (x && f(x)) { if (fwd[j] != null) ex.push(fwd[j] - avg); if (fwd6 && avg6 != null && fwd6[j] != null) ex6.push(fwd6[j] - avg6); } });
      for (const [reg, rf] of Object.entries(REGS)) { if (!rf(dd)) continue;
        if (ex.length) { const A = acc[reg][g]; A.ex.push(...ex); (A.years[yr] = A.years[yr] || []).push(mean(ex)); }
        if (ex6.length) { const B = acc6[reg][g]; B.ex.push(...ex6); (B.years[yr] = B.years[yr] || []).push(mean(ex6)); } } }
  }
  const sum = A => ({ n: A.ex.length, mean: A.ex.length ? +(mean(A.ex) * 100).toFixed(2) : null, median: A.ex.length ? +(median(A.ex) * 100).toFixed(2) : null,
    beat: A.ex.length ? Math.round(A.ex.filter(v => v > 0).length / A.ex.length * 100) : null,
    years: Object.fromEntries(Object.entries(A.years).map(([y, v]) => [y, +(mean(v) * 100).toFixed(1)])) });
  const test = { at: new Date().toISOString().slice(0, 10), rule: 'last 40 sessions: top 30% vs the S&P on its down days (-0.5% or worse), top half on its up days (+0.5% or better), within 15% of the 52-week high',
    forward: '63 sessions (3 months) and 126 sessions (6 months, in m6), vs the average stock of the list', dates, corrDates, nDates,
    ...Object.fromEntries(Object.keys(REGS).map(reg => [reg, Object.fromEntries(Object.keys(groups).map(g => [g, sum(acc[reg][g])]))])),
    m6: Object.fromEntries(Object.keys(REGS).map(reg => [reg, Object.fromEntries(Object.keys(groups).map(g => [g, sum(acc6[reg][g])]))])) };
  // today's measures (last session)
  const now = at(n - 1), today = {};
  if (now) now.forEach((x, j) => { if (x) today[tks[j]] = [Math.round(x.pDn * 100), Math.round(x.pUp * 100), x.near ? 1 : 0, isRes(x) ? 1 : 0]; });
  return { test, today: { at: new Date(D[n - 1] * 864e5).toISOString().slice(0, 10), cols: ['downPct', 'upPct', 'nearHigh', 'resists'], rows: today, calm: !now } };
}
