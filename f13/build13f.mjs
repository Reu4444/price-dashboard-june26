// Active funds in each US stock, from the SEC 13F data sets (public, quarterly).
// For each stock of the dashboard: the active funds that hold it, the value, the weight of the stock in the fund's 13F portfolio,
// and the change in shares since the previous quarter. Writes f13.json at the repo root; keeps f13/cusip_map.json (CUSIP -> ticker) between runs.
//   node f13/build13f.mjs
// Needs: unzip (on the GitHub runner). Optional secrets: SEC_UA (a contact for the SEC, e.g. "Name email@domain"), OPENFIGI_KEY (faster CUSIP mapping).
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';

const UA = process.env.SEC_UA || 'MarketWire 13F study github.com/Reu4444/price-dashboard-june26';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxqVzEtKgrjf8GXQS1jePSsagDeIMHPOH-DsQycdtCL7Go1eZiCQ8GsCweo9xw-sss/exec';
const TMP = '/tmp/f13', MAPF = 'f13/cusip_map.json', OUT = 'f13.json';
const MIN_FUND = 1e9;      // active funds with a 13F portfolio of $1 billion or more
const MIN_POS = 1e6;       // positions of $1 million or more
const MIN_MAP = 50e6;      // CUSIPs held for $50 million or more by active funds are mapped to a ticker
// not active managers: index funds, banks and brokers holding client accounts, market makers, quant funds, central banks
const NOT_ACTIVE = /\b(vanguard|blackrock|state street|geode|northern trust|schwab|dimensional|invesco|norges|legal & general|ubs|morgan stanley|jpmorgan|j\.?p\.? morgan|bank of america|bofa|merrill|wells fargo|goldman sachs|royal bank of canada|rbc|bank of new york|bny|mellon|deutsche bank|dws|barclays|citigroup|citadel|susquehanna|jane street|hudson river|virtu|optiver|imc|flow traders|ameriprise|lpl financial|raymond james|edward jones|stifel|envestnet|commonwealth equity|swiss national bank|toronto[- ]dominion|bnp|hsbc|natixis|amundi|nomura|mizuho|mitsubishi ufj|sumitomo|ssga|qube|two sigma|renaissance|d\.? ?e\.? shaw|millennium|balyasny|squarepoint|cubist|point72|marshall wace|arrowstreet|aqr)\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = (url, as) => fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(600000) }).then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return as === 'buf' ? r.arrayBuffer() : r.text(); });

// the data set files, newest first ("01sep2026-30nov2026_form13f.zip" or the older "2024q1_form13f.zip")
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function endOf(name) {
  let m = name.match(/(\d{2})([a-z]{3})(\d{4})_form13f/i); if (m) return Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]);
  m = name.match(/(\d{4})q([1-4])_form13f/i); if (m) return Date.UTC(+m[1], +m[2] * 3, 1);
  return 0;
}
async function dataSets() {
  const html = await sec('https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets');
  const urls = [...new Set([...html.matchAll(/href="([^"]+_form13f\.zip)"/gi)].map(m => m[1].startsWith('http') ? m[1] : 'https://www.sec.gov' + m[1]))];
  return urls.sort((a, b) => endOf(b) - endOf(a));
}

async function tsv(file, fn) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity }); let head = null;
  for await (const line of rl) { const v = line.split('\t'); if (!head) { head = Object.fromEntries(v.map((h, i) => [h.trim().toUpperCase(), i])); continue; } fn(v, head); }
}
const col = (v, h, k) => (h[k] == null ? '' : (v[h[k]] || '').trim());

// one data set: the 13F-HR of its main period, and every position (long shares, no options) by fund and CUSIP
async function load(url, k, keepCusips) {
  const dir = `${TMP}/${k}`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  console.log(`Download ${url}`);
  if (url.startsWith('file:')) execSync(`cp ${url.slice(5)} ${dir}/d.zip`); else writeFileSync(`${dir}/d.zip`, Buffer.from(await sec(url, 'buf')));   // file: = a local test
  execSync(`unzip -o -q d.zip`, { cwd: dir });
  const f = n => { const p = execSync(`find . -iname '${n}'`, { cwd: dir }).toString().trim().split('\n')[0]; if (!p) throw new Error('missing ' + n); return `${dir}/${p}`; };
  const sub = new Map(), per = new Map();
  await tsv(f('SUBMISSION.tsv'), (v, h) => { if (col(v, h, 'SUBMISSIONTYPE') !== '13F-HR') return;
    const p = col(v, h, 'PERIODOFREPORT'); per.set(p, (per.get(p) || 0) + 1);
    sub.set(col(v, h, 'ACCESSION_NUMBER'), { cik: col(v, h, 'CIK'), period: p, filed: col(v, h, 'FILING_DATE') }); });
  const period = [...per.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // the latest 13F-HR of each fund for that period
  const best = new Map(); for (const [acc, s] of sub) { if (s.period !== period) continue; const o = best.get(s.cik); if (!o || Date.parse(s.filed) > Date.parse(o.filed)) best.set(s.cik, { acc, ...s }); }
  const accs = new Map([...best.values()].map(s => [s.acc, s.cik]));
  const name = new Map(); await tsv(f('COVERPAGE.tsv'), (v, h) => { const acc = col(v, h, 'ACCESSION_NUMBER'); if (accs.has(acc)) name.set(accs.get(acc), col(v, h, 'FILINGMANAGER_NAME')); });
  const pos = new Map(), issuer = new Map();   // cik -> Map(cusip -> [value, shares])
  await tsv(f('INFOTABLE.tsv'), (v, h) => { const cik = accs.get(col(v, h, 'ACCESSION_NUMBER')); if (!cik) return;
    if (col(v, h, 'PUTCALL') || (col(v, h, 'SSHPRNAMTTYPE') || 'SH').toUpperCase() !== 'SH') return;
    const cu = col(v, h, 'CUSIP').toUpperCase(); if (cu.length < 8 || (keepCusips && !keepCusips.has(cu))) return;
    const val = parseFloat(col(v, h, 'VALUE')) || 0, sh = parseFloat(col(v, h, 'SSHPRNAMT')) || 0;
    if (!pos.has(cik)) pos.set(cik, new Map()); const m = pos.get(cik), o = m.get(cu) || [0, 0]; o[0] += val; o[1] += sh; m.set(cu, o);
    if (!issuer.has(cu)) issuer.set(cu, col(v, h, 'NAMEOFISSUER')); });
  rmSync(dir, { recursive: true, force: true });
  console.log(`  period ${period}: ${best.size} funds, ${issuer.size} CUSIPs`);
  return { period, name, pos, issuer };
}

// CUSIP -> US ticker (OpenFIGI), kept between runs
async function mapCusips(cusips, map) {
  const todo = cusips.filter(c => !(c in map)), key = process.env.OPENFIGI_KEY, per = key ? 100 : 10, wait = key ? 300 : 2600;
  console.log(`CUSIP map: ${Object.keys(map).length} known, ${todo.length} to look up`);
  for (let i = 0; i < todo.length; i += per) {
    const part = todo.slice(i, i + per);
    for (let tr = 0; tr < 5; tr++) {
      const r = await fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-OPENFIGI-APIKEY': key } : {}) },
        body: JSON.stringify(part.map(c => ({ idType: 'ID_CUSIP', idValue: c, exchCode: 'US' }))), signal: AbortSignal.timeout(60000) }).catch(() => null);
      if (r && r.status === 429) { await sleep(61000); continue; }
      if (!r || !r.ok) { await sleep(5000); continue; }
      const j = await r.json(); part.forEach((c, n) => { const d = j[n] && j[n].data; const x = d && (d.find(y => /common|ADR|REIT|equity|share/i.test(y.securityType || '')) || d[0]); map[c] = x && x.ticker ? x.ticker.replace('/', '.').toUpperCase() : null; });
      break;
    }
    await sleep(wait);
    if ((i / per) % 50 === 0) console.log(`  ${Math.min(i + per, todo.length)} / ${todo.length}`);
  }
  return map;
}

async function universe() {
  for (let k = 0; k < 3; k++) { try { const r = await fetch(`${APPS_SCRIPT_URL}?action=info&t=${Date.now()}`, { signal: AbortSignal.timeout(240000), redirect: 'follow' }); const j = await r.json();
    if (j && j.data && j.data.length > 1) return new Set(j.data.slice(1).map(x => String(x[0] || '').trim().toUpperCase()).filter(Boolean)); } catch (e) { console.log('  universe: ' + e.message); } await sleep(5000); }
  return null;
}

(async () => {
  const t0 = Date.now();
  const sets = await dataSets(); if (sets.length < 2) { console.log('No 13F data sets found: stop.'); process.exit(1); }
  const tickers = await universe(); if (!tickers) { console.log('No stock list: stop.'); process.exit(1); }
  const now = await load(sets[0], 'now');
  // the active funds and their total 13F portfolio (long shares)
  const funds = new Map();
  for (const [cik, m] of now.pos) { const nm = now.name.get(cik) || ''; if (!nm || NOT_ACTIVE.test(nm)) continue;
    let tot = 0; for (const [, o] of m) tot += o[0]; if (tot >= MIN_FUND) funds.set(cik, { nm, tot }); }
  // CUSIPs held for $50M+ by active funds
  const held = new Map(); for (const [cik] of funds) for (const [cu, o] of now.pos.get(cik)) held.set(cu, (held.get(cu) || 0) + o[0]);
  const want = [...held.entries()].filter(([, v]) => v >= MIN_MAP).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  console.log(`${funds.size} active funds of $1B+, ${want.length} CUSIPs held for $50M+`);
  const map = await mapCusips(want, existsSync(MAPF) ? JSON.parse(readFileSync(MAPF, 'utf8')) : {});
  writeFileSync(MAPF, JSON.stringify(map));
  const cuOf = new Map(); for (const cu of want) { const tk = map[cu]; if (tk && tickers.has(tk)) cuOf.set(cu, tk); }
  console.log(`${cuOf.size} CUSIPs match a stock of the dashboard (${tickers.size} US stocks)`);
  // the previous quarter: shares of the same funds in the same CUSIPs
  let prev = null; try { prev = await load(sets[1], 'prev', new Set(cuOf.keys())); } catch (e) { console.log('Previous quarter: ' + e.message); }
  const rows = {};
  for (const [cik, f] of funds) for (const [cu, o] of now.pos.get(cik)) {
    const tk = cuOf.get(cu); if (!tk || o[0] < MIN_POS) continue;
    const pm = prev && prev.pos.get(cik), po = pm && pm.get(cu);
    const chg = !prev || !pm ? null : !po || !po[1] ? 'new' : Math.round((o[1] / po[1] - 1) * 100);
    (rows[tk] = rows[tk] || []).push([f.nm, Math.round(o[0] / 1e6), +(o[0] / f.tot * 100).toFixed(2), chg]);
  }
  // per stock: the 10 largest active holders, and the 5 with the highest weight (the convictions, $50M+)
  const out = {};
  for (const [tk, a] of Object.entries(rows)) {
    const big = a.slice().sort((x, y) => y[1] - x[1]).slice(0, 10), conv = a.filter(x => x[1] >= 50).sort((x, y) => y[2] - x[2]).slice(0, 5);
    out[tk] = { n: a.length, big, conv };
  }
  const fmt = p => { const m = String(p).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); return m ? new Date(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1])).toISOString().slice(0, 10) : p; };   // 30-SEP-2026 -> 2026-09-30
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString().slice(0, 10), asOf: fmt(now.period), prev: prev ? fmt(prev.period) : null, funds: funds.size, cols: ['fund', 'valueM', 'weightPct', 'chgSharesPct'], rows: out }));
  console.log(`f13.json: ${Object.keys(out).length} stocks, as of ${now.period}, in ${Math.round((Date.now() - t0) / 60000)} min`);
  for (const tk of ['AAPL', 'MSFT', 'MSCI', 'NVDA']) if (out[tk]) console.log(`  ${tk}: ${out[tk].big.slice(0, 3).map(x => `${x[0]} $${x[1]}M ${x[2]}% ${x[3]}`).join(' | ')}`);
})().catch(e => { console.log('Failed: ' + e.message); process.exit(1); });
