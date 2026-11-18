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

// The real falls of the S&P 500: from its high to its low, 7% or more, with their dates.
// For each fall, every stock is measured on the same dates (apples to apples):
//   at the low: how much it moved from the S&P's high to the S&P's low, then its next 3 and 6 months vs the average stock;
//   5 weeks (25 sessions) after the low: how much it rose since the low, then its next 3 and 6 months vs the average stock.
// The low is only known afterwards: this checks what the stocks did, it is not a signal you could take on the day.
const EP_MIN = 0.07, AFTER = 25, REB = 0.05, WATCH = ['AMD', 'DELL', 'MU', 'SNDK', 'NVDA', 'AVGO'];
export function episodes(spy, stocks) {
  const day = t => Math.floor(t / 864e5), D = spy.map(x => day(x.t)), pos = new Map(D.map((d, i) => [d, i])), n = D.length, M = spy.map(x => x.a);
  const iso = i => new Date(D[i] * 864e5).toISOString().slice(0, 10);
  const tks = [...stocks.keys()], P = tks.map(tk => { const a = new Array(n).fill(null); for (const x of stocks.get(tk)) { const i = pos.get(day(x.t)); if (i != null) a[i] = x.a; } return a; });
  const mv = (a, i, j) => j < n && a[i] > 0 && a[j] > 0 ? a[j] / a[i] - 1 : null;
  // the falls: from a high, down to the lowest close before the S&P gets back above that high
  const eps = []; let pk = 0;
  for (let i = 1; i < n; i++) {
    if (M[i] >= M[pk]) { pk = i; continue; }
    let end = i; while (end < n && M[end] < M[pk]) end++;
    let tr = i; for (let k = i; k < end; k++) if (M[k] < M[tr]) tr = k;
    const depth = 1 - M[tr] / M[pk];
    if (depth >= EP_MIN && pk >= 252) eps.push({ pk, tr, end, depth });
    pk = end < n ? end : pk; i = end;
  }
  const rsAt = (a, i) => { const r = [63, 126, 189, 252].map(k => mv(a, i - k, i)); return r.every(x => x != null) ? 0.4 * r[0] + 0.2 * r[1] + 0.2 * r[2] + 0.2 * r[3] : null; };
  // one group's result from date i: mean of (stock - average stock) over 3 and 6 months, in %
  const res = (members, i) => {
    const out = {};
    for (const [key, f] of [['m3', 63], ['m6', 126]]) {
      const all = P.map(a => mv(a, i, i + f)), ok = all.filter(v => v != null); if (!ok.length) { out[key] = null; continue; }
      const avg = mean(ok), ex = members.map(j => all[j]).filter(v => v != null).map(v => v - avg);
      out[key] = ex.length ? +(mean(ex) * 100).toFixed(1) : null; out['avg' + key.slice(1)] = +(avg * 100).toFixed(1);
    }
    return { n: members.length, ...out };
  };
  const list = eps.map(e => {
    const { pk, tr } = e, af = tr + AFTER;
    const fall = P.map(a => mv(a, pk, tr)), pF = pctRank(fall);
    const rs = pctRank(P.map(a => rsAt(a, tr))), rise = af < n ? P.map(a => mv(a, tr, af)) : P.map(() => null), pR = pctRank(rise);
    const idx = f => P.map((_, j) => j).filter(f);
    const atLow = {
      held20: res(idx(j => pF[j] != null && pF[j] >= 0.8), tr),        // the 20% that fell least (or rose)
      flat: res(idx(j => fall[j] != null && fall[j] >= -0.03), tr),      // flat or up during the fall (-3% or better)
      worst20: res(idx(j => pF[j] != null && pF[j] <= 0.2), tr),         // the 20% that fell most
      rs90: res(idx(j => rs[j] != null && rs[j] >= 0.9), tr) };          // the 10% with the best RS at the low
    const after = af < n ? {
      rise20: res(idx(j => pR[j] != null && pR[j] >= 0.8), af),          // the 20% that rose most in the 5 weeks after the low
      held20: res(idx(j => pF[j] != null && pF[j] >= 0.8), af),
      flat: res(idx(j => fall[j] != null && fall[j] >= -0.03), af),
      worst20: res(idx(j => pF[j] != null && pF[j] <= 0.2), af) } : null;
    const watch = {}; for (const tk of WATCH) { const j = tks.indexOf(tk); if (j < 0 || fall[j] == null) continue;
      watch[tk] = { fall: +(fall[j] * 100).toFixed(1), rank: Math.round(pF[j] * 100), rise5w: rise[j] == null ? null : +(rise[j] * 100).toFixed(1), m3: mv(P[j], tr, tr + 63) == null ? null : +(mv(P[j], tr, tr + 63) * 100).toFixed(1), m6: mv(P[j], tr, tr + 126) == null ? null : +(mv(P[j], tr, tr + 126) * 100).toFixed(1) }; }
    const top = fall.map((v, j) => [tks[j], v, mv(P[j], tr, tr + 126)]).filter(x => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([tk, v, f]) => [tk, +(v * 100).toFixed(1), f == null ? null : +(f * 100).toFixed(1)]);
    // the day the S&P is clearly back up: first close 5% or more above its low (known on the day, unlike the low)
    let rb = tr + 1; while (rb < n && M[rb] < M[tr] * (1 + REB)) rb++;
    let rebound = null;
    if (rb < n) {
      const med = (js, f) => { const v = js.map(j => mv(P[j], rb, rb + f)).filter(x => x != null); return v.length ? +(median(v) * 100).toFixed(1) : null; };
      const q = (lo, hi) => idx(j => pF[j] != null && pF[j] >= lo && (hi >= 1 ? pF[j] <= hi : pF[j] < hi));
      const mid = Math.floor((pk + tr) / 2), lowIn = (a, i, j) => { let m = Infinity; for (let k = i; k <= j; k++) if (a[k] != null && a[k] < m) m = a[k]; return m; };
      const hl = P.map(a => { if (tr - pk < 10 || a[pk] == null || a[tr] == null) return null; const l1 = lowIn(a, pk, mid), l2 = lowIn(a, mid + 1, tr); return isFinite(l1) && isFinite(l2) ? (l2 >= l1 ? 1 : 0) : null; });
      const rb0 = pctRank(P.map(a => rsAt(a, pk))), r0 = j => rb0[j] == null ? null : rb0[j] * 100;   // RS on the day of the S&P's high, before the fall
      const B = { fellMost: q(0, 0.2), q2: q(0.2, 0.4), q3: q(0.4, 0.6), q4: q(0.6, 0.8), heldBest: q(0.8, 1), rs90: idx(j => rs[j] != null && rs[j] >= 0.9),
        rsBefore90: idx(j => r0(j) != null && r0(j) >= 90), rsBefore70: idx(j => r0(j) != null && r0(j) >= 70 && r0(j) < 90), rsBefore30: idx(j => r0(j) != null && r0(j) >= 30 && r0(j) < 70), rsBeforeLow: idx(j => r0(j) != null && r0(j) < 30),
        rsBefore90_held: idx(j => r0(j) != null && r0(j) >= 90 && pF[j] != null && pF[j] >= 0.5), rsBefore90_fell: idx(j => r0(j) != null && r0(j) >= 90 && pF[j] != null && pF[j] < 0.5),
        rsBefore80_held20: idx(j => r0(j) != null && r0(j) >= 80 && pF[j] != null && pF[j] >= 0.8),   // strong before AND among the 20% that held best
        // O'Neil: the next leaders do not make a new low when the S&P makes its new low. Second half of the fall vs first half (closes).
        heldLow: idx(j => hl[j] === 1), brokeLow: idx(j => hl[j] === 0), heldLow_rs70: idx(j => hl[j] === 1 && r0(j) != null && r0(j) >= 70), brokeLow_rs70: idx(j => hl[j] === 0 && r0(j) != null && r0(j) >= 70),
        all: idx(j => pF[j] != null) };
      rebound = { date: iso(rb), sessionsAfterLow: rb - tr, spy: Object.fromEntries([['m1', 21], ['m3', 63], ['m6', 126]].map(([k, f]) => [k, rb + f < n ? +((M[rb + f] / M[rb] - 1) * 100).toFixed(1) : null])),
        groups: Object.fromEntries(Object.entries(B).map(([k, js]) => [k, { n: js.length, m1: med(js, 21), m3: med(js, 63), m6: med(js, 126) }])) };
    }
    return { rebound, high: iso(pk), low: iso(tr), back: e.end < n ? iso(e.end) : null, fall: +(e.depth * 100).toFixed(1), sessions: tr - pk, stocks: fall.filter(v => v != null).length, atLow, after, watch, heldBest: top };
  });
  // all falls together: each fall counts once
  const summ = (part, g) => { const v = list.map(e => e[part] && e[part][g]).filter(x => x && x.m3 != null);
    const s = k => { const w = v.map(x => x[k]).filter(x => x != null); return w.length ? { mean: +mean(w).toFixed(1), beat: w.filter(x => x > 0).length, of: w.length } : null; };
    return { m3: s('m3'), m6: s('m6') }; };
  const summary = { atLow: Object.fromEntries(['held20', 'flat', 'worst20', 'rs90'].map(g => [g, summ('atLow', g)])), after: Object.fromEntries(['rise20', 'held20', 'flat', 'worst20'].map(g => [g, summ('after', g)])) };
  const rbG = ['fellMost', 'q2', 'q3', 'q4', 'heldBest', 'rs90', 'rsBefore90', 'rsBefore70', 'rsBefore30', 'rsBeforeLow', 'rsBefore90_held', 'rsBefore90_fell', 'rsBefore80_held20', 'heldLow', 'brokeLow', 'heldLow_rs70', 'brokeLow_rs70', 'all'];
  summary.rebound = Object.fromEntries(rbG.map(g => [g, Object.fromEntries(['m1', 'm3', 'm6'].map(k => { const v = list.filter(e => e.rebound && e.rebound.groups[g][k] != null && e.rebound.groups.all[k] != null);
    return [k, v.length ? { med: +mean(v.map(e => e.rebound.groups[g][k])).toFixed(1), beatAll: v.filter(e => e.rebound.groups[g][k] > e.rebound.groups.all[k]).length, of: v.length } : null]; }))]));
  return { rule: `S&P 500 falls of ${EP_MIN * 100}% or more, high to low (closes). Groups measured on the same dates for every stock; next 3 and 6 months vs the average stock of the list. Today's list of US stocks: survivorship bias.`, list, summary };
}

// Ryan (Momentum Masters): "your best moves occur when the stock you own is in one of the top 25% of all groups".
// Every 20 sessions: groups (4+ stocks) ranked by the median RS score of their stocks; next 3 and 6 months of the stocks vs the average stock.
export function groupsTest(spy, stocks, grpOf) {
  const day = t => Math.floor(t / 864e5), D = spy.map(x => day(x.t)), pos = new Map(D.map((d, i) => [d, i])), n = D.length;
  const tks = [...stocks.keys()].filter(tk => grpOf.get(tk)), P = tks.map(tk => { const a = new Array(n).fill(null); for (const x of stocks.get(tk)) { const i = pos.get(day(x.t)); if (i != null) a[i] = x.a; } return a; });
  const G = tks.map(tk => grpOf.get(tk)), mv = (a, i, j) => j < n && a[i] > 0 && a[j] > 0 ? a[j] / a[i] - 1 : null;
  const rsAt = (a, i) => { const r = [63, 126, 189, 252].map(k => mv(a, i - k, i)); return r.every(x => x != null) ? 0.4 * r[0] + 0.2 * r[1] + 0.2 * r[2] + 0.2 * r[3] : null; };
  const names = ['topGroup', 'midGroup', 'bottomGroup', 'rs90_topGroup', 'rs90_otherGroup', 'rs90'], acc = {}; for (const k of names) acc[k] = { m3: [], m6: [], w3: 0, w6: 0, d: 0 };
  let dates = 0;
  for (let i = 260; i + 63 < n; i += 20) {
    const sc = P.map(a => rsAt(a, i)), rk = pctRank(sc), by = new Map(); sc.forEach((v, j) => { if (v != null) { if (!by.has(G[j])) by.set(G[j], []); by.get(G[j]).push(v); } });
    const gs = [...by.entries()].filter(([, v]) => v.length >= 4).map(([g, v]) => [g, median(v)]); if (gs.length < 8) continue;
    const gr = pctRank(gs.map(x => x[1])), gp = new Map(gs.map((x, k) => [x[0], gr[k]])); dates++;
    for (const [key, f] of [['m3', 63], ['m6', 126]]) { if (i + f >= n) continue;
      const fw = P.map(a => mv(a, i, i + f)), ok = fw.filter(v => v != null); if (!ok.length) continue; const avg = mean(ok);
      const ex = sel => { const v = []; fw.forEach((x, j) => { if (x != null && sel(j)) v.push(x - avg); }); return v.length ? mean(v) : null; };
      const q = j => gp.get(G[j]), r9 = j => rk[j] != null && rk[j] >= 0.9;
      const res = { topGroup: ex(j => q(j) != null && q(j) >= 0.75), midGroup: ex(j => q(j) != null && q(j) >= 0.25 && q(j) < 0.75), bottomGroup: ex(j => q(j) != null && q(j) < 0.25),
        rs90_topGroup: ex(j => r9(j) && q(j) != null && q(j) >= 0.75), rs90_otherGroup: ex(j => r9(j) && q(j) != null && q(j) < 0.75), rs90: ex(r9) };
      for (const k of names) if (res[k] != null) { acc[k][key].push(res[k]); if (res[k] > 0) acc[k][key === 'm3' ? 'w3' : 'w6']++; } }
  }
  const out = {}; for (const k of names) { const A = acc[k]; out[k] = { m3: A.m3.length ? +(mean(A.m3) * 100).toFixed(2) : null, beat3: A.m3.length ? Math.round(A.w3 / A.m3.length * 100) : null, m6: A.m6.length ? +(mean(A.m6) * 100).toFixed(2) : null, beat6: A.m6.length ? Math.round(A.w6 / A.m6.length * 100) : null }; }
  return { rule: 'groups of 4+ stocks ranked by the median RS score of their stocks, every 20 sessions; mean of (stock - average stock) per date, in %; beat = share of dates above the average stock', dates, stocks: tks.length, groups: new Set(G).size, res: out };
}

// Raschke & Connors, Street Smarts ch. 10, "The Holy Grail": in a strong trend (14-day ADX above 30), buy the first pullback to the 20-day EMA,
// above the high of the bar that touched it; stop under the swing low; first target = the last swing high.
// Test on daily bars, uptrends only. Control = the same first touch of the 20-day EMA with a weak trend (ADX under 20).
// Forward returns are from the close of the entry day, minus the average stock over the same days. stocks: Map tk -> [{ t, h, l, c }]
export function holyGrail(spy, stocks) {
  const day = t => Math.floor(t / 864e5), D = spy.map(x => day(x.t)), pos = new Map(D.map((d, i) => [d, i])), n = D.length, tks = [...stocks.keys()];
  const mk = () => new Array(n).fill(null), S = tks.map(tk => { const h = mk(), l = mk(), c = mk(); for (const x of stocks.get(tk)) { const i = pos.get(day(x.t)); if (i != null) { h[i] = x.h; l[i] = x.l; c[i] = x.c; } } return { h, l, c }; });
  const FW = [5, 10, 21, 63];
  // the average stock: mean close-to-close return of all stocks from each day, per horizon
  const avg = FW.map(f => { const a = new Array(n).fill(null); for (let i = 0; i + f < n; i++) { let t = 0, k = 0; for (const x of S) if (x.c[i] > 0 && x.c[i + f] > 0) { t += x.c[i + f] / x.c[i] - 1; k++; } a[i] = k ? t / k : null; } return a; });
  const kinds = { strong: { ex: FW.map(() => []), hit: 0, stop: 0, n: 0, years: {} }, mid: { ex: FW.map(() => []), hit: 0, stop: 0, n: 0, years: {} }, weak: { ex: FW.map(() => []), hit: 0, stop: 0, n: 0, years: {} } };
  for (const x of S) {
    const { h, l, c } = x, adx = mk(), ema = mk(); let tr = 0, pd = 0, md = 0, ax = null, e = null, cnt = 0, dxs = 0;
    for (let i = 1; i < n; i++) {
      if (c[i] == null || c[i - 1] == null) { cnt = 0; tr = pd = md = dxs = 0; ax = null; e = null; continue; }
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i], t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])), p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      cnt++; e = e == null ? c[i] : e + (c[i] - e) * 2 / 21; if (cnt >= 20) ema[i] = e;
      if (cnt <= 14) { tr += t; pd += p; md += m; } else { tr = tr - tr / 14 + t; pd = pd - pd / 14 + p; md = md - md / 14 + m; }
      if (cnt >= 14 && tr > 0) { const pi = pd / tr, mi = md / tr, dx = pi + mi > 0 ? Math.abs(pi - mi) / (pi + mi) * 100 : 0;
        if (cnt < 28) { dxs += dx; if (cnt === 27) ax = dxs / 14; } else ax = (ax * 13 + dx) / 14; if (ax != null && cnt >= 28) adx[i] = ax; }
    }
    for (let i = 60; i + 1 < n; i++) {
      if (ema[i] == null || adx[i] == null || c[i - 20] == null || h[i + 1] == null) continue;
      if (!(l[i] <= ema[i] && c[i] > c[i - 60] && ema[i] > ema[i - 10])) continue;                      // touches the 20-day EMA, in an uptrend
      let first = true; for (let k = 1; k <= 5; k++) if (l[i - k] == null || ema[i - k] == null || l[i - k] <= ema[i - k]) { first = false; break; } if (!first) continue;   // first touch in 5 sessions
      let am = 0, pk = 0; for (let k = 0; k <= 10; k++) { if (adx[i - k] > am) am = adx[i - k]; } for (let k = 1; k <= 20; k++) if (h[i - k] > pk) pk = h[i - k];
      if (!(h[i + 1] > h[i])) continue;                                                                    // entry: the next day trades above the high of the touch bar
      const kind = am > 30 ? 'strong' : am < 20 ? 'weak' : 'mid', K = kinds[kind], en = i + 1, entry = Math.max(h[i], l[en]), stop = Math.min(l[i], l[en]);
      K.n++; FW.forEach((f, q) => { if (en + f < n && c[en + f] > 0 && c[en] > 0 && avg[q][en] != null) K.ex[q].push(c[en + f] / c[en] - 1 - avg[q][en]); });
      for (let k = en + 1; k <= en + 20 && k < n; k++) { if (l[k] != null && l[k] < stop) { K.stop++; break; } if (h[k] != null && h[k] >= pk && pk > entry) { K.hit++; break; } }
      const yr = new Date(D[en] * 864e5).getUTCFullYear(); if (en + 21 < n && c[en + 21] > 0 && avg[2][en] != null) (K.years[yr] = K.years[yr] || []).push(c[en + 21] / c[en] - 1 - avg[2][en]);
      i += 5;
    }
  }
  const out = {}; for (const [k, K] of Object.entries(kinds)) out[k] = { n: K.n, targetFirst: K.n ? Math.round(K.hit / K.n * 100) : null, stopFirst: K.n ? Math.round(K.stop / K.n * 100) : null,
    ...Object.fromEntries(FW.map((f, q) => ['d' + f, K.ex[q].length ? { mean: +(mean(K.ex[q]) * 100).toFixed(2), median: +(median(K.ex[q]) * 100).toFixed(2), beat: Math.round(K.ex[q].filter(v => v > 0).length / K.ex[q].length * 100) } : null])),
    years: Object.fromEntries(Object.entries(K.years).map(([y, v]) => [y, +(mean(v) * 100).toFixed(1)])) };
  return { rule: 'first touch of the 20-day EMA in an uptrend, entry the next day above the high of the touch bar. strong = ADX(14) above 30 in the last 10 sessions, weak = under 20, mid = between. dN = return N sessions after the entry day close, minus the average stock (%). targetFirst / stopFirst = last 20-day high or the swing low reached first, within 20 sessions (% of trades)', res: out };
}
