// Offline, append-only refresh. Run before publishing a research snapshot;
// never fetch/recompute historical bars on the live 2-second quote path.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { alignCashReturns, parseChart } from './extend-taiwan-adr-study.mjs';

const localDay = t => new Date(t * 1000 + 8 * 3600000).toISOString().slice(0, 10);
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
const nyDay = t => nyDate.format(t * 1000);
const stamp = (date, hour) => Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00+08:00`) / 1000;

export function completedAdrPoints(payload) {
  const data = payload.chart?.result?.[0];
  if (payload.chart?.error || data?.meta?.symbol !== 'TSM' || data.meta.currency !== 'USD') throw Error('Invalid TSM ADR identity');
  const closes = data.indicators?.quote?.[0]?.close, opens = data.indicators?.quote?.[0]?.open;
  // Match the original study: aligned hourly bars, completion at min(start+1h, next start).
  // The appended live last-tick row is not an hourly observation.
  const bars = (data.timestamp ?? []).flatMap((t, i) => Number.isFinite(t) && t % 1800 === 0 && Number.isFinite(opens?.[i]) && opens[i] > 0 && Number.isFinite(closes?.[i]) && closes[i] > 0 ? [{ t, price: closes[i] }] : []);
  return bars.map((bar, i) => ({ timestamp: Math.min(bar.t + 3600, bars[i+1]?.t ?? Infinity), price: bar.price }));
}

export function adrInput(date, previousDate, points, eventDates = []) {
  const anchorTarget = stamp(previousDate, 14), cutoff = stamp(date, 9);
  const before = target => points.filter(p => p.timestamp <= target && target - p.timestamp <= 4 * 86400).at(-1);
  const anchor = before(anchorTarget), preOpen = before(cutoff);
  if (!anchor || !preOpen) return { date, previousDate, excluded: 'missing_ADR_history' };
  if (eventDates.some(d => nyDay(anchor.timestamp) < d && d <= nyDay(preOpen.timestamp))) return { date, previousDate, excluded:'ADR_corporate_action' };
  return { date, previousDate, anchorTarget, cutoff, anchor, preOpen, adrReturn: preOpen.price / anchor.price - 1 };
}

export function appendStudy(original, adrRows, cashByCode, target) {
  const sample = structuredClone(original);
  for (const adr of adrRows) {
    if (adr.date <= original.asOf || adr.date > target || !Number.isFinite(adr.adrReturn)) continue;
    if (sample.dates.includes(adr.date) || adr.date <= sample.dates.at(-1)) throw Error('Research dates are not strictly increasing');
    const values = Object.keys(sample.returns0930).map(code => {
      const row = cashByCode[code]?.find(r => r.date === adr.date);
      return [code, row?.previousDate === adr.previousDate && Number.isFinite(row?.return0930) ? row.return0930 : null];
    });
    if (!values.some(([, value]) => value !== null)) continue;
    sample.dates.push(adr.date); sample.adrReturns.push(adr.adrReturn);
    for (const [code, value] of values) sample.returns0930[code].push(value);
  }
  sample.asOf = sample.dates.at(-1);
  if (sample.asOf !== target) throw Error(`Latest completed session ${target} cannot yet be verified (last valid: ${sample.asOf}); retain current snapshot`);
  return sample;
}

async function fetchPayload(symbol, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${interval === '30m' ? '60d' : '1mo'}&includePrePost=true&events=div%2Csplits`;
  const response = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${symbol} ${interval} HTTP ${response.status}`);
  return { payload:await response.json(), url, fetchedAt:new Date().toISOString() };
}

async function main() {
  const now = Date.now();
  const basisCode = stripTypeScriptTypes(await readFile(new URL('../app/lib/taiwanStockBasis.ts', import.meta.url), 'utf8'));
  const { latestTaiwanCashClose, TWSE_2026 } = await import('data:text/javascript;base64,' + Buffer.from(basisCode).toString('base64'));
  // Require a publication buffer after 13:30 and a known holiday calendar.
  const targetTime = latestTaiwanCashClose(now - 30 * 60000, [TWSE_2026]);
  if (targetTime === null) throw Error('No verified TWSE calendar for current date');
  const target = localDay(targetTime / 1000);
  const sampleUrl = new URL('../app/data/taiwanAdrStudy.json', import.meta.url);
  const original = JSON.parse(await readFile(sampleUrl, 'utf8'));
  if (original.asOf >= target) { console.log(`Already current through ${original.asOf}`); return; }
  const sources = [], cash = {};
  let referenceDaily;
  for (const code of Object.keys(original.returns0930)) {
    const symbol = `${code}.TW`;
    const responses = await Promise.all(['1d','60m','30m'].map(interval => fetchPayload(symbol, interval)));
    const [daily, hourly, half] = responses.map(r => parseChart(r.payload, symbol));
    sources.push(...responses.map(({url,fetchedAt}) => ({url,fetchedAt})));
    if (code === '2330') referenceDaily = daily;
    const dates = daily.bars.map(bar => localDay(bar.t)).filter(d => d > original.asOf && d <= target);
    cash[code] = alignCashReturns(dates, daily, hourly, half);
  }
  const adrResponses = await Promise.all(['60m','1d'].map(interval => fetchPayload('TSM', interval)));
  sources.push(...adrResponses.map(({url,fetchedAt}) => ({url,fetchedAt})));
  const points = completedAdrPoints(adrResponses[0].payload);
  const eventDates = adrResponses.flatMap(r => Object.values(r.payload.chart.result[0].events ?? {}).flatMap(events => Object.values(events).map(event => nyDay(event.date))));
  const daily = referenceDaily.bars;
  const adrRows = daily.flatMap((bar, i) => {
    const date = localDay(bar.t);
    if (!i || date <= original.asOf || date > target) return [];
    return [adrInput(date, localDay(daily[i-1].t), points, eventDates)];
  });
  const sample = appendStudy(original, adrRows, cash, target);
  sample.refresh = { updatedAt:new Date(now).toISOString(), through:target, excluded:adrRows.filter(row => !sample.dates.includes(row.date)).map(row => ({date:row.date, reason:row.excluded ?? 'No verified cash half-hour bars'})) };
  const audit = { updatedAt:new Date(now).toISOString(), from:original.asOf, through:target, priorDateCount:original.dates.length,
    method:'Append completed Taiwan sessions only; preserve original sample. TSM completed extended-hours hourly bars at/before prior TW date 14:00 and current TW date 09:00. Cash 09:00–09:30 close / previous daily close - 1. Corporate-action/mismatched/missing data excluded, never zero-filled.', sources, adrRows, cash };
  await mkdir(new URL('../tests/fixtures/', import.meta.url), { recursive:true });
  await writeFile(new URL(`../tests/fixtures/taiwan-adr-refresh-${target}.json`, import.meta.url), JSON.stringify(audit,null,2)+'\n');
  await writeFile(sampleUrl, JSON.stringify(sample)+'\n');
  console.log(`Updated ${original.asOf} → ${target}: ${sample.dates.length} reference dates`);
  for (const [code, values] of Object.entries(sample.returns0930)) console.log(`${code}: ${values.filter(Number.isFinite).length} valid observations`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
