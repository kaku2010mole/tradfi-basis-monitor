// Offline research update only. Never run on the server's quote/polling path.
// Keep the original ADR dates/returns and eight stocks unchanged; add valid
// 09:00–09:30 cash-bar closes for Hon Hai and MediaTek on that same date grid.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const day = t => new Date(t * 1000 + 8 * 3600000).toISOString().slice(0, 10);
const time = t => new Date(t * 1000 + 8 * 3600000).toISOString().slice(11, 16);
const positive = n => Number.isFinite(n) && n > 0;
const mismatch = (a, b) => Math.abs(a / b - 1) > 0.0001;

export function parseChart(payload, symbol) {
  const result = payload.chart?.result?.[0];
  if (payload.chart?.error || result?.meta?.symbol !== symbol || result.meta.currency !== 'TWD') throw Error(`Invalid chart identity for ${symbol}`);
  const q = result.indicators?.quote?.[0];
  if (!q || !result.timestamp?.length) throw Error(`No bars for ${symbol}`);
  const bars = result.timestamp.flatMap((t, i) => positive(q.open?.[i]) && positive(q.close?.[i])
    ? [{ t, open: q.open[i], close: q.close[i] }] : []);
  return { bars, eventDates: Object.values(result.events ?? {}).flatMap(category => Object.values(category).map(event => day(event.date))) };
}

export function alignCashReturns(dates, daily, hourly, halfHourly) {
  const dailyByDate = new Map(daily.bars.map((bar, i) => [day(bar.t), { bar, previous: daily.bars[i - 1] }]));
  const hours = new Map(hourly.bars.filter(bar => time(bar.t) === '09:00').map(bar => [day(bar.t), bar]));
  const halves = new Map(halfHourly.bars.map(bar => [`${day(bar.t)} ${time(bar.t)}`, bar]));
  const events = new Set([...daily.eventDates, ...hourly.eventDates, ...halfHourly.eventDates]);
  return dates.map(date => {
    const d = dailyByDate.get(date), h = hours.get(date);
    const first = halves.get(`${date} 09:00`), second = halves.get(`${date} 09:30`);
    let excluded;
    if (events.has(date)) excluded = 'cash_corporate_action';
    else if (!d?.previous) excluded = 'missing_daily_previous_close';
    else if (!first || !second) excluded = 'missing_half_hour_bars';
    else if (!h) excluded = 'missing_09_10_bar';
    else if (mismatch(h.open, d.bar.open)) excluded = 'hourly_daily_open_mismatch';
    else if (mismatch(first.open, d.bar.open)) excluded = 'half_hour_daily_open_mismatch';
    else if (mismatch(second.close, h.close)) excluded = 'half_hour_hourly_10am_mismatch';
    if (excluded) return { date, excluded, return0930: null };
    return { date, previousDate: day(d.previous.t), previousClose: d.previous.close,
      dailyOpen: d.bar.open, hourlyOpen: h.open, hourlyClose: h.close,
      firstBar: first, secondBar: second, return0930: first.close / d.previous.close - 1 };
  });
}

async function fetchChart(symbol, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${interval === '30m' ? '60d' : '1y'}&includePrePost=true&events=div%2Csplits`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${symbol} ${interval}: HTTP ${response.status}`);
  const chart = parseChart(await response.json(), symbol);
  return { ...chart, url, fetchedAt: new Date().toISOString() };
}

async function main() {
  const sampleUrl = new URL('../app/data/taiwanAdrStudy.json', import.meta.url);
  const auditUrl = new URL('../tests/fixtures/taiwan-adr-extension-audit.json', import.meta.url);
  const sample = JSON.parse(await readFile(sampleUrl, 'utf8'));
  const audit = { method: 'Frozen original TSM ADR predictor and dates. 09:30 return = 09:00–09:30 Taiwan cash bar close / previous daily close - 1. Reported corporate actions and inconsistent bars excluded. Missing bars remain null, never zero.', stocks: {} };
  // Fetch both completely before modifying the snapshot; an outage leaves it intact.
  for (const code of ['2317', '2454']) {
    const symbol = `${code}.TW`;
    const [daily, hourly, half] = await Promise.all(['1d', '60m', '30m'].map(interval => fetchChart(symbol, interval)));
    const rows = alignCashReturns(sample.dates, daily, hourly, half);
    if (rows.filter(row => row.return0930 !== null).length < 20) throw Error(`Insufficient verified bars: ${symbol}`);
    sample.returns0930[code] = rows.map(row => row.return0930);
    audit.stocks[code] = { symbol, sources: [daily, hourly, half].map(({ url, fetchedAt, eventDates }) => ({ url, fetchedAt, eventDates })), rows };
    console.log(`${symbol}: ${rows.filter(row => row.return0930 !== null).length}/${rows.length} valid observations`);
  }
  await mkdir(new URL('./', auditUrl), { recursive: true });
  await writeFile(auditUrl, JSON.stringify(audit, null, 2) + '\n');
  await writeFile(sampleUrl, JSON.stringify(sample) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
