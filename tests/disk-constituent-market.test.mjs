import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`;
const sessions = url(await readFile(new URL('../app/lib/smicOpening.ts', import.meta.url), 'utf8'));
const fund = (stockWeight) => ({ asOf: '2026-11-10', source: 'issuer', cashWeight: 0, holdings: [
  { symbol: 'AAPL', name: 'U.S. stock', currency: 'USD', weight: stockWeight },
  { symbol: '285A.T', name: 'Japanese stock', currency: 'JPY', weight: 1 - stockWeight },
] });
const source = (await readFile(new URL('../app/lib/diskConstituentMarket.ts', import.meta.url), 'utf8'))
  .replace('from "./smicOpening"', `from ${JSON.stringify(sessions)}`)
  .replace('import { getDiskDramHoldings } from "./diskDramHoldings";', `const getDiskDramHoldings = async () => (${JSON.stringify({ DISK: fund(.5), DRAM: fund(.7) })});`);
const { createDiskConstituentClient, closedConstituentReference } = await import(url(source));
const at = value => Date.parse(value);
const anchor = { date: '2026-11-10', at: at('2026-11-11T05:00:00+08:00') };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('complete constituent returns use the same cash anchor, real FX and shared background refresh', async () => {
  let now = at('2026-11-11T10:00:00+08:00'), offline = false, calls = 0;
  const fetcher = async input => {
    calls++;
    if (offline) throw Error('feed unavailable');
    const path = String(input);
    if (path.includes('/quote/AAPL/')) return new Response(`<script data-sveltekit-fetched data-url="https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL">${JSON.stringify({ body: JSON.stringify({ quoteResponse: { result: [{ symbol: 'AAPL', currency: 'USD', quoteSourceName: 'BOATS Real Time Price', regularMarketPrice: { raw: 250 }, regularMarketTime: anchor.at / 1000, overnightMarketPrice: { raw: 252 }, overnightMarketTime: (now - 10000) / 1000 }] } }) })}</script>`);
    if (path.includes('/chart/285A.T')) return Response.json({ chart: { result: [{ meta: { symbol: '285A.T', currency: 'JPY', regularMarketPrice: 11000, regularMarketTime: (now - 60000) / 1000, currentTradingPeriod: { regular: { start: at('2026-11-11T09:00:00+09:00') / 1000, end: at('2026-11-11T15:30:00+09:00') / 1000 } } }, timestamp: [at('2026-11-10T09:00:00+09:00') / 1000, at('2026-11-11T09:00:00+09:00') / 1000], indicators: { quote: [{ close: [10000, 11000] }] } }] } });
    if (path.includes('/chart/JPY%3DX')) return Response.json({ chart: { result: [{ meta: { symbol: 'USDJPY=X', currency: 'JPY', regularMarketPrice: 160, regularMarketTime: (now - 10000) / 1000 }, timestamp: [anchor.at / 1000 - 300, anchor.at / 1000], indicators: { quote: [{ close: [160, 999] }] } }] } });
    throw Error('Unexpected source ' + path);
  };
  const get = createDiskConstituentClient({ clock: () => now, fetcher });
  assert.equal(get(anchor).status, 'loading');
  for (let i = 0; i < 20; i++) get(anchor);
  await settle();
  const result = get(anchor);
  assert.equal(result.status, 'ready');
  assert.ok(Math.abs(result.diskReturn - .054) < 1e-12);
  assert.ok(Math.abs(result.dramReturn - .0356) < 1e-12);
  assert.equal(result.rows.find(row => row.symbol === '285A.T').basePrice, 10000, 'today partial daily close cannot replace the anchor');
  assert.equal(result.rows.find(row => row.symbol === '285A.T').baseFxAt, anchor.at, 'only a completed FX bar can enter the anchor');
  assert.equal(calls, 3, 'concurrent visitors share one refresh');
  offline = true;
  now += 40 * 60000;
  const expired = get(anchor);
  assert.equal(expired.status, 'partial');
  assert.equal(expired.diskReturn, null);
  assert.equal(expired.coverage.DISK, 0);
  await settle();
  const nextAnchor = { date: '2026-11-11', at: at('2026-11-12T05:00:00+08:00') };
  now = nextAnchor.at + 60000;
  assert.equal(get(nextAnchor).status, 'loading', 'prior-session adjusted returns never leak across anchor rollover');
  await settle();
  assert.equal(get(nextAnchor).diskReturn, null);
  assert.equal(get(nextAnchor).anchorAt, nextAnchor.at);
});

test('closed foreign prices remain timestamped references while active-session stale prices stay invalid', () => {
  const start = at('2026-11-11T09:00:00+09:00'), end = at('2026-11-11T15:30:00+09:00');
  const quote = { price: 10000, at: end - 60000, source: 'cash trade' };
  const session = { start, end, close: { price: 10000, at: end, source: 'completed close' } };
  assert.match(closedConstituentReference('285A.T', quote, session, end + 2 * 3600000), /market closed/);
  assert.equal(quote.at, end - 60000, 'closed-reference classification does not rewrite the trade time');
  assert.equal(closedConstituentReference('285A.T', quote, session, end - 3600000), null);
  assert.equal(closedConstituentReference('285A.T', { ...quote, price: 9999 }, session, end + 3600000), null);
  assert.equal(closedConstituentReference('285A.T', quote, session, at('2026-11-12T10:00:00+09:00')), null, 'prior-day session metadata cannot carry a stale price into the next open');
  const prior = { price: 10000, at: end - 86400000, source: 'prior close' };
  assert.match(closedConstituentReference('285A.T', prior, { start, end, close: prior }, start - 3600000), /market closed/);
  const lunchQuote = { price: 10000, at: at('2026-11-11T11:29:00+09:00'), source: 'cash trade' };
  assert.match(closedConstituentReference('285A.T', lunchQuote, session, at('2026-11-11T12:15:00+09:00')), /lunch break/);
});
