// DNA of every stock of the dashboard (US and ROW), the same measures as the Market Wire stock page.
// Runs on GitHub Actions (weekly, or by hand), writes dna.json next to index.html. No packages needed (Node 20+).
//   node dna/build.mjs            -> all stocks
//   node dna/build.mjs --limit 20 -> a quick test on 20 stocks per universe
import { writeFileSync } from 'node:fs';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxqVzEtKgrjf8GXQS1jePSsagDeIMHPOH-DsQycdtCL7Go1eZiCQ8GsCweo9xw-sss/exec';
const OUT = process.env.DNA_OUT || 'dna.json';
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? +process.argv[i + 1] : 0; })();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- symbols ----------
// TradingView exchange prefix -> Yahoo suffix
const TV_Y = { BIT: '.MI', MIL: '.MI', EPA: '.PA', AMS: '.AS', EBR: '.BR', ELI: '.LS', LON: '.L', LSE: '.L', ETR: '.DE', XETR: '.DE', FWB: '.F', FRA: '.F',
  SWX: '.SW', SIX: '.SW', BME: '.MC', STO: '.ST', OMXSTO: '.ST', CPH: '.CO', OMXCOP: '.CO', OSL: '.OL', HEL: '.HE', OMXHEX: '.HE', VIE: '.VI', WSE: '.WA', GPW: '.WA',
  TLV: '.TA', TSE: '.T', HKEX: '.HK', TSX: '.TO', TSXV: '.V', ASX: '.AX', KRX: '.KS', TWSE: '.TW', SGX: '.SI', NSE: '.NS', BSE: '.BO', BMFBOVESPA: '.SA', BMV: '.MX',
  ISE: '.IR', EURONEXTDUB: '.IR', JSE: '.JO', SSE: '.SS', SZSE: '.SZ', NZX: '.NZ', OMXICE: '.IC' };
const EURONEXT = { france: '.PA', netherlands: '.AS', belgium: '.BR', portugal: '.LS', ireland: '.IR', norway: '.OL', italy: '.MI' };
// Bloomberg exchange code -> Yahoo suffix (if the sheet uses "ISP IM")
const BBG_Y = { IM: '.MI', BB: '.BR', LN: '.L', FP: '.PA', SW: '.SW', SE: '.SW', VX: '.SW', GR: '.DE', GY: '.DE', GF: '.F', NA: '.AS', SM: '.MC', SQ: '.MC', SS: '.ST',
  DC: '.CO', NO: '.OL', FH: '.HE', ID: '.IR', PL: '.LS', AV: '.VI', JP: '.T', JT: '.T', HK: '.HK', CN: '.TO', CT: '.TO', AU: '.AX', AT: '.AX', KS: '.KS', TT: '.TW',
  SP: '.SI', IN: '.NS', BZ: '.SA', MM: '.MX', IT: '.TA', PW: '.WA' };
const YSUF = new Set(Object.values(TV_Y).concat(Object.values(BBG_Y)));
function yahooOf(tk, country, isUS) {
  let t = String(tk || '').trim().toUpperCase(); if (!t) return null;
  if (isUS) return t.replace(/[./ ]/g, '-');
  const dot = t.lastIndexOf('.'); if (!t.includes(':') && !t.includes(' ') && dot > 0 && YSUF.has(t.slice(dot))) return t;   // already Yahoo (ISP.MI)
  let ex = '', sym = t;
  if (t.includes(':')) [ex, sym] = t.split(':'); else if (t.includes(' ')) { const p = t.split(/\s+/); sym = p[0]; ex = p[1]; }
  let suf = ex === 'EURONEXT' ? EURONEXT[String(country || '').toLowerCase()] || '.PA' : TV_Y[ex] || BBG_Y[ex] || '';
  if (!ex) return sym.replace(/[./]/g, '-');   // no exchange: a US listing
  if (!suf) return null;
  if (suf === '.HK' && /^\d+$/.test(sym)) sym = sym.padStart(4, '0');
  return sym.replace(/\.$/, '').replace(/[._/]/g, '-') + suf;
}

// ---------- prices ----------
async function daily(ysym) {   // 10 years of daily bars: [{ t, h, l, c, a }] (c split-adjusted, a with dividends)
  for (let k = 0; k < 4; k++) {
    try {
      const host = k % 2 ? 'query2' : 'query1';
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?range=10y&interval=1d`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * (k + 1)); continue; }
      if (!r.ok) return null;
      const j = await r.json(), c = j && j.chart && j.chart.result && j.chart.result[0], q = c && c.indicators && c.indicators.quote && c.indicators.quote[0];
      const ad = c && c.indicators && c.indicators.adjclose && c.indicators.adjclose[0] && c.indicators.adjclose[0].adjclose;
      if (!q || !c.timestamp) return null;
      const rows = []; for (let i = 0; i < c.timestamp.length; i++) { const cl = q.close[i], h = q.high[i], l = q.low[i]; if (cl > 0 && h > 0 && l > 0) rows.push({ t: c.timestamp[i] * 1000, h, l, c: cl, a: ad && ad[i] > 0 ? ad[i] : cl }); }
      return rows;
    } catch (e) { await sleep(2000 * (k + 1)); }
  }
  return null;
}

// ---------- measures (copied from the Market Wire Worker: charCalc, dnaMore) ----------
const r2 = v => Math.round(v * 100) / 100, p1 = v => Math.round(v * 1000) / 10;
const sdOf = a => { const m = a.reduce((t, x) => t + x, 0) / a.length; return Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / (a.length - 1)); };
// Sharpe: return per year with dividends (month ends) / volatility per year (daily returns x sqrt 252); no risk-free rate
function risk(rows) {
  const n = rows.length; if (n < 300) return null;
  const mon = []; for (let i = 0; i < n; i++) { const k = new Date(rows[i].t).toISOString().slice(0, 7); if (mon.length && mon[mon.length - 1].k === k) mon[mon.length - 1].a = rows[i].a; else mon.push({ k, a: rows[i].a }); }
  mon.pop(); if (mon.length < 25) return null;
  const yrs = (mon.length - 1) / 12, cagr = Math.pow(mon[mon.length - 1].a / mon[0].a, 1 / yrs) - 1;
  const dr = []; for (let i = 1; i < n; i++) dr.push(Math.log(rows[i].a / rows[i - 1].a));
  const vol = sdOf(dr) * Math.sqrt(252);
  return { years: Math.round(yrs * 10) / 10, cagr: p1(cagr), vol: p1(vol), sharpe: vol > 0 ? r2(cagr / vol) : null };
}
// pullbacks over the whole history: a low that is the lowest of the 10 sessions before and after, at least 3 ATR under the high of the 30 sessions before;
// it "stopped at" the 20, 50, 100, 200 or 325-day average when the low was within 1 ATR of it
function pullbacks(rows) {
  const n = rows.length; if (n < 400) return null;
  const cs = [0]; for (let i = 0; i < n; i++) cs.push(cs[i] + rows[i].c); const sma = (len, i) => i < len - 1 ? null : (cs[i + 1] - cs[i + 1 - len]) / len;
  const atr = new Array(n).fill(null); { let a = 0; for (let i = 1; i < n; i++) { const tr = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c)); if (i <= 14) { a += tr / 14; if (i === 14) atr[i] = a; } else { a = (a * 13 + tr) / 14; atr[i] = a; } } }
  const at = { 20: 0, 50: 0, 100: 0, 200: 0, 325: 0 }; let np = 0;
  for (let i = 335; i < n - 10; i++) { const lo = rows[i].l; let isLow = true; for (let j = i - 10; j <= i + 10; j++) if (j !== i && rows[j].l < lo) { isLow = false; break; }
    if (!isLow || !(atr[i] > 0)) continue; let hi = 0; for (let j = i - 30; j < i; j++) if (rows[j].h > hi) hi = rows[j].h; if (hi - lo < 3 * atr[i]) continue;
    let best = null, bd = 1; for (const len of [20, 50, 100, 200, 325]) { const m = sma(len, i); if (m == null) continue; const d = Math.abs(lo - m) / atr[i]; if (d <= bd) { bd = d; best = len; } }
    if (best) at[best]++; np++; }
  return { n: np, at };
}
// with the index, its sector and US tech (monthly returns); usual 3-month dip; trending or consolidating (efficiency over 50 sessions, 0.25+ = trending)
function more(sd, bd, secd, techd, facs) {
  if (!sd || sd.length < 500) return null;
  const monthly = arr => { const m = new Map(); for (const [d, v] of arr || []) m.set(new Date(d * 864e5).toISOString().slice(0, 7), v); return m; };
  const S = monthly(sd), keys = [...S.keys()].slice(0, -1);
  const rets = M => { const o = new Map(); for (let i = 1; i < keys.length; i++) { const a = M.get(keys[i - 1]), b = M.get(keys[i]); if (a > 0 && b > 0) o.set(keys[i], b / a - 1); } return o; };
  const rs = rets(S), pair = M => { if (!M) return null; const q = rets(M), x = [], y = []; for (const [k, v] of rs) if (q.has(k)) { x.push(v); y.push(q.get(k)); } return x.length >= 24 ? [x, y] : null; };
  const corr = p => { if (!p) return null; const [x, y] = p, n = x.length, mx = x.reduce((t, v) => t + v, 0) / n, my = y.reduce((t, v) => t + v, 0) / n; let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx > 0 && syy > 0 ? r2(sxy / Math.sqrt(sxx * syy)) : null; };
  const out = {}, pb = pair(monthly(bd));
  out.corrMkt = corr(pb); out.corrSec = secd ? corr(pair(monthly(secd))) : null; out.corrTech = techd ? corr(pair(monthly(techd))) : null;
  // macro: oil (Brent futures), rates (TLT: bond prices, sign turned to speak of rates), the dollar (UUP), high yield credit (HYG)
  if (facs) { const c = k => facs[k] ? corr(pair(monthly(facs[k]))) : null; out.corrOil = c('BZ=F'); const t = c('TLT'); out.corrRates = t == null ? null : -t; out.corrUsd = c('UUP'); out.corrHy = c('HYG'); }
  if (pb) { const [x, y] = pb, n = x.length, my = y.reduce((t, v) => t + v, 0) / n, mx = x.reduce((t, v) => t + v, 0) / n; let cov = 0, vm = 0; for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vm += (y[i] - my) ** 2; }
    const up = [], dn = []; for (let i = 0; i < n; i++) (y[i] >= 0 ? up : dn).push(i); const av = (idx, a) => idx.reduce((t, i) => t + a[i], 0) / idx.length;
    out.beta = vm > 0 ? r2(cov / vm) : null;
    if (up.length >= 6 && dn.length >= 6) { out.upCap = Math.round(av(up, x) / av(up, y) * 100); out.dnCap = Math.round(av(dn, x) / av(dn, y) * 100); } }
  const dd3 = arr => { if (!arr || arr.length < 200) return null; let t = 0, k = 0; for (let i = 0; i + 63 < arr.length; i += 5) { let pk = arr[i][1], w = 0; for (let j = i; j <= i + 63; j++) { if (arr[j][1] > pk) pk = arr[j][1]; w = Math.min(w, arr[j][1] / pk - 1); } t += w; k++; } return k ? p1(t / k) : null; };
  out.dd3 = dd3(sd); out.dd3B = dd3((bd || []).filter(x => x[0] >= sd[0][0]));
  { let up = 0, dn = 0, k = 0, path = 0; const mv = i => Math.abs(sd[i][1] - sd[i - 1][1]);
    for (let i = 1; i <= 50 && i < sd.length; i++) path += mv(i);
    for (let i = 50; i < sd.length; i++) { if (i > 50) path += mv(i) - mv(i - 50); const net = sd[i][1] - sd[i - 50][1]; if (!(path > 0)) continue; k++; if (Math.abs(net) / path >= 0.25) { if (net > 0) up++; else dn++; } }
    if (k >= 250) { out.trUp = Math.round(up / k * 100); out.trDn = Math.round(dn / k * 100); out.cons = 100 - out.trUp - out.trDn; } }
  return out;
}

// ---------- indexes ----------
const SECTOR_ETF = { technology: 'XLK', healthcare: 'XLV', 'health care': 'XLV', financials: 'XLF', communications: 'XLC', 'communication services': 'XLC', discretionary: 'XLY',
  'consumer discretionary': 'XLY', staples: 'XLP', 'consumer staples': 'XLP', materials: 'XLB', 'real estate': 'XLRE', energy: 'XLE', industrials: 'XLI', utilities: 'XLU' };
const EUROPE = ['united kingdom', 'france', 'germany', 'italy', 'spain', 'netherlands', 'belgium', 'switzerland', 'sweden', 'denmark', 'norway', 'finland', 'ireland', 'portugal', 'austria', 'poland', 'luxembourg'];
// the index of each stock (in its own market and currency)
const BENCH = { us: ['SPY', 'S&P 500'], eu: ['EXSA.DE', 'Stoxx 600'], jp: ['1306.T', 'Topix'], hk: ['2800.HK', 'Hang Seng'], ca: ['XIU.TO', 'TSX 60'], au: ['IOZ.AX', 'ASX 200'],
  kr: ['069500.KS', 'Kospi 200'], tw: ['0050.TW', 'Taiwan 50'], in: ['NIFTYBEES.NS', 'Nifty 50'], world: ['ACWI', 'MSCI ACWI'] };
function benchOf(country, isUS, ysym) {
  if (isUS) return 'us';
  const c = String(country || '').toLowerCase(), suf = (ysym.match(/\.[A-Z]+$/) || [''])[0];
  if (EUROPE.includes(c) || ['.MI', '.PA', '.AS', '.BR', '.LS', '.L', '.DE', '.F', '.SW', '.MC', '.ST', '.CO', '.OL', '.HE', '.VI', '.WA', '.IR'].includes(suf)) return 'eu';
  return { '.T': 'jp', '.HK': 'hk', '.TO': 'ca', '.AX': 'au', '.KS': 'kr', '.TW': 'tw', '.NS': 'in' }[suf] || 'world';
}

// ---------- the list of stocks (the dashboard's sheets, through its Apps Script) ----------
async function sheet(action) {
  for (let k = 0; k < 3; k++) { try { const r = await fetch(`${APPS_SCRIPT_URL}?action=${action}&t=${Date.now()}`, { signal: AbortSignal.timeout(240000), redirect: 'follow' }); const j = await r.json(); if (j && j.data && j.data.length > 1) return j.data; } catch (e) { console.log(`  ${action}: ${e.message}`); } await sleep(5000); }
  return null;
}

async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }; await Promise.all(Array.from({ length: n }, run)); }

(async () => {
  const t0 = Date.now();
  const [us, row] = await Promise.all([sheet('info'), sheet('info_row')]);
  if (!us && !row) { console.log('No stock list from the Apps Script: stop (dna.json kept as it was).'); process.exit(1); }
  const list = [], num = v => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(x) && x > 0 ? x : null; };   // market cap: $ billions (US), € billions (ROW)
  for (const r of (us || []).slice(1)) { const tk = String(r[0] || '').trim().toUpperCase(); if (tk) list.push({ tk, uni: 'us', sector: String(r[3] || ''), cap: num(r[2]), y: yahooOf(tk, '', true) }); }
  for (const r of (row || []).slice(1)) { const tk = String(r[0] || '').trim().toUpperCase(); if (tk) list.push({ tk, uni: 'row', country: String(r[2] || ''), sector: String(r[6] || ''), cap: num(r[5]) != null ? num(r[5]) / 1e9 : null, y: yahooOf(tk, r[2], false) }); }
  const todo = LIMIT ? [...list.filter(x => x.uni === 'us').slice(0, LIMIT), ...list.filter(x => x.uni === 'row').slice(0, LIMIT)] : list;
  console.log(`${list.length} stocks in the sheets (US ${list.filter(x => x.uni === 'us').length}, ROW ${list.filter(x => x.uni === 'row').length}); measuring ${todo.length}`);

  // indexes, sector ETFs and US tech: daily, 10 years
  const idx = {}; const FAC = ['BZ=F', 'TLT', 'UUP', 'HYG'], want = new Set([...Object.values(BENCH).map(b => b[0]), ...Object.values(SECTOR_ETF), ...FAC]);
  await pool([...want], 4, async s => { const rows = await daily(s); if (rows && rows.length > 300) idx[s] = rows; else console.log(`  index ${s}: no data`); });
  const series = rows => rows.map(x => [Math.floor(x.t / 864e5), x.a]);
  const idxS = Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, series(v)]));

  const COLS = ['bench', 'years', 'sharpe', 'cagr', 'vol', 'sharpeB', 'beta', 'upCap', 'dnCap', 'corrMkt', 'sec', 'corrSec', 'corrTech', 'trUp', 'trDn', 'cons', 'pN', 'p20', 'p50', 'p100', 'p200', 'p325', 'dd3', 'dd3B', 'from', 'cap', 'corrOil', 'corrRates', 'corrUsd', 'corrHy', 'r2q'];
  const out = {}, miss = [], objs = []; let ok = 0, noSym = 0, noData = 0;
  await pool(todo, 6, async (x, k) => {
    if (!x.y) { noSym++; miss.push(x.tk + ' (no Yahoo symbol)'); return; }
    const rows = await daily(x.y); await sleep(process.env.DNA_FAST ? 0 : 150);
    if (!rows || rows.length < 500) { noData++; miss.push(`${x.tk} = ${x.y} (${rows ? rows.length + ' days' : 'no data'})`); return; }
    const bk = benchOf(x.country, x.uni === 'us', x.y), bsym = BENCH[bk][0], brows = idx[bsym];
    const rk = risk(rows); if (!rk) { noData++; return; }
    // the index over the same years as the stock (like for like)
    const rkB = brows ? risk(brows.filter(b => b.t >= rows[0].t)) : null;
    const sec = x.uni === 'us' ? SECTOR_ETF[x.sector.toLowerCase().trim()] || null : null;
    const m = more(series(rows), idxS[bsym], sec ? idxS[sec] : null, idxS.XLK, Object.fromEntries(FAC.map(f => [f, idxS[f]]))) || {}, pl = pullbacks(rows) || { n: 0, at: {} };
    // trend quality: R² of the log price (with dividends) on time over the last 6 months (127 sessions), as on the stock page
    const r2q = (() => { const w = rows.slice(-127); if (w.length < 127) return null; const ys = w.map(x => Math.log(x.a)), xm = (ys.length - 1) / 2, ym = ys.reduce((t, y) => t + y, 0) / ys.length; let sxy = 0, sxx = 0, syy = 0;
      ys.forEach((y, i) => { sxy += (i - xm) * (y - ym); sxx += (i - xm) ** 2; syy += (y - ym) ** 2; }); return syy > 0 ? r2(sxy * sxy / (sxx * syy)) : null; })();
    const o = { bench: bk, r2q, ...rk, sharpeB: rkB ? rkB.sharpe : null, ...m, sec, pN: pl.n, p20: pl.at[20], p50: pl.at[50], p100: pl.at[100], p200: pl.at[200], p325: pl.at[325], from: new Date(rows[0].t).toISOString().slice(0, 10), cap: x.cap != null ? Math.round(x.cap * 10) / 10 : null };
    out[x.tk] = COLS.map(c => o[c] ?? null); objs.push({ ...o, uni: x.uni }); ok++;
    if ((k + 1) % 200 === 0) console.log(`  ${k + 1} / ${todo.length}`);
  });
  console.log(`measured ${ok}, no Yahoo symbol ${noSym}, no data or under 2 years ${noData}, ${Math.round((Date.now() - t0) / 1000)} s`);
  if (miss.length) console.log('not measured (first 40): ' + miss.slice(0, 40).join(', '));
  if (ok < todo.length * 0.5) { console.log('Less than half measured (Yahoo blocked?): stop (dna.json kept as it was).'); process.exit(1); }
  const benches = Object.fromEntries(Object.entries(BENCH).map(([k, [s, name]]) => [k, { sym: s, name }]));
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cols: COLS, benches, n: { listed: list.length, measured: ok }, rows: out }));
  // the average stock (for the Market Wire stock page and its Method): [p10, p25, median, p75, p90] of each measure, for all stocks, $10B+ and $50B+, and US / Europe
  const q5 = a => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (v.length < 20) return null; const q = p => v[Math.floor(p * (v.length - 1))]; return [0.1, 0.25, 0.5, 0.75, 0.9].map(p => Math.round(q(p) * 100) / 100); };
  const stats = L => { const has = o => o.trUp != null, sh = L.filter(o => o.sharpe != null && o.sharpeB != null), prof = L.filter(o => o.beta != null && o.upCap != null);
    const pf = k => prof.length ? Math.round(prof.filter(o => k === 'off' ? o.beta >= 1.15 && o.upCap >= 110 : k === 'def' ? o.beta <= 0.85 && o.dnCap <= 85 : !(o.beta >= 1.15 && o.upCap >= 110) && !(o.beta <= 0.85 && o.dnCap <= 85)).length / prof.length * 100) : null;
    return { n: L.length, sharpe: q5(L.map(o => o.sharpe)), beatIdx: sh.length ? Math.round(sh.filter(o => o.sharpe > o.sharpeB).length / sh.length * 100) : null, cagr: q5(L.map(o => o.cagr)), vol: q5(L.map(o => o.vol)),
      beta: q5(L.map(o => o.beta)), upCap: q5(L.map(o => o.upCap)), dnCap: q5(L.map(o => o.dnCap)), off: pf('off'), neu: pf('neu'), def: pf('def'),
      corrMkt: q5(L.map(o => o.corrMkt)), corrSec: q5(L.map(o => o.corrSec)), corrTech: q5(L.map(o => o.corrTech)), corrOil: q5(L.map(o => o.corrOil)), corrRates: q5(L.map(o => o.corrRates)), corrUsd: q5(L.map(o => o.corrUsd)), corrHy: q5(L.map(o => o.corrHy)), r2q: q5(L.map(o => o.r2q)),
      trend: q5(L.filter(has).map(o => o.trUp + o.trDn)), trUp: q5(L.filter(has).map(o => o.trUp)), trDn: q5(L.filter(has).map(o => o.trDn)), dd3: (q5(L.map(o => o.dd3)) || null)?.reverse() ?? null,
      full10: L.filter(o => o.years >= 9.5).length }; };
  const idx10 = k => { const o = objs.find(x => x.bench === k && x.years >= 9.5); return o ? { sharpe: o.sharpeB, dd3: o.dd3B } : null; };
  const AVG = { at: new Date().toISOString().slice(0, 10), note: 'US market cap in $ billions, ROW in € billions (from the sheets)',
    all: stats(objs), cap10: stats(objs.filter(o => o.cap >= 10)), cap50: stats(objs.filter(o => o.cap >= 50)), us: stats(objs.filter(o => o.uni === 'us')), eu: stats(objs.filter(o => o.bench === 'eu')),
    index: { us: idx10('us'), eu: idx10('eu') } };
  writeFileSync(OUT.replace(/dna\.json$/, 'dna_avg.json'), JSON.stringify(AVG));
  console.log(`average stock: all ${AVG.all.n}, $10B+ ${AVG.cap10.n}, $50B+ ${AVG.cap50.n}`);
  console.log(`wrote ${OUT}`);
})();
