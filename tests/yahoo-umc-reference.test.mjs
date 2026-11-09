import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = async name => stripTypeScriptTypes(await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'));
const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const parser = (await source('yahooUmcReference'))
  .replace(/(['"])\.\/taiwanStockBasis\1/g, JSON.stringify(dataUrl(await source('taiwanStockBasis'))))
  .replace(/(['"])\.\/smicOpening\1/g, JSON.stringify(dataUrl(await source('smicOpening'))));
const { parseYahooUmcReference } = await import(dataUrl(parser));

const path = 'https://query1.finance.yahoo.com';
const script = (url, data) => `<script type="application/json" data-sveltekit-fetched data-url="${url}">${JSON.stringify({ body: JSON.stringify(data) })}</script>`;
const quote = fields => ({ symbol: 'UMC', currency: 'USD', ...fields });
const v7 = (...quotes) => script(`${path}/v7/finance/quote?symbols=UMC`, { quoteResponse: { result: quotes } });
const v10 = price => script(`${path}/v10/finance/quoteSummary/UMC?modules=price`, { quoteSummary: { result: [{ price }] } });
const time = value => Date.parse(value);
const marketQuote = (field, price, at, wrapTime = true) => ({
  [`${field}MarketPrice`]: { raw: price },
  [`${field}MarketTime`]: wrapTime ? { raw: time(at) / 1000 } : time(at) / 1000,
});

const priorClose = marketQuote('regular', 13.85, '2026-10-22T20:00:02Z');
const night = { ...marketQuote('overnight', 14.31, '2026-10-23T07:59:47Z'), overnightMarketSource: 'BOATS Real Time Price' };
const pre = marketQuote('pre', 14.46, '2026-10-23T08:00:17Z', false);
const regular = marketQuote('regular', 14.51, '2026-10-23T13:30:03Z');
const post = marketQuote('post', 14.69, '2026-10-23T20:00:19Z', false);
const boats = 'Yahoo Finance · Blue Ocean ATS overnight';

test('Yahoo UMC rotates from overnight to pre, regular and post using the matching original trade times', () => {
  const snapshots = [
    [v7(quote({ ...priorClose, ...night, marketState: 'OVERNIGHT' })), '2026-10-23T07:59:58Z', 14.31, '2026-10-23T07:59:47Z', 'overnight', boats],
    [v10(quote({ ...priorClose, ...night, ...pre, marketState: 'PRE' })), '2026-10-23T08:00:28Z', 14.46, '2026-10-23T08:00:17Z', 'pre', 'Yahoo Finance'],
    [v7(quote({ ...night, ...pre, ...regular, marketState: 'REGULAR' })), '2026-10-23T13:30:20Z', 14.51, '2026-10-23T13:30:03Z', 'regular', 'Yahoo Finance'],
    [v10(quote({ ...night, ...pre, ...regular, ...post, marketState: 'POST' })), '2026-10-23T20:00:30Z', 14.69, '2026-10-23T20:00:19Z', 'post', 'Yahoo Finance'],
  ];
  for (const [html, now, price, at, session, source] of snapshots) {
    assert.deepEqual(parseYahooUmcReference(html, time(now)), { price, timestamp: time(at), session, source, marketOpen: true });
  }
});

test('after closing, Yahoo keeps the newest actual print and its previous-session label', () => {
  const html = v10(quote({ ...regular, ...post, marketState: 'CLOSED' }));
  assert.deepEqual(parseYahooUmcReference(html, time('2026-10-24T00:01:00Z')), {
    price: 14.69, timestamp: time('2026-10-23T20:00:19Z'), session: 'post', source: 'Yahoo Finance', marketOpen: false,
  });
});

test('at a session boundary, yesterday’s, incomplete or future premarket data cannot supplant the night trade', () => {
  const unavailablePremarket = [
    marketQuote('pre', 99, '2026-10-22T08:00:00Z'),
    { preMarketPrice: { raw: 99 } },
    marketQuote('pre', 99, '2026-10-23T08:02:00Z'),
  ];
  for (const preFields of unavailablePremarket) {
    const html = v7(quote({ ...priorClose, ...night, ...preFields, marketState: 'PRE' }));
    assert.deepEqual(parseYahooUmcReference(html, time('2026-10-23T08:01:00Z')), {
      price: 14.31, timestamp: time('2026-10-23T07:59:47Z'), session: 'overnight', source: boats, marketOpen: false,
    });
  }
});

test('Yahoo picks the newest verified print across embedded payloads and rejects other symbols and non-BOATS night values', () => {
  const newest = quote({ ...night, marketState: 'OVERNIGHT' });
  const older = quote({ ...night, ...marketQuote('overnight', 14.22, '2026-10-23T07:56:00Z'), marketState: 'OVERNIGHT' });
  const falsePrice = marketQuote('overnight', 99, '2026-10-23T07:59:54Z');
  const unverified = quote({ ...falsePrice, quoteSourceName: 'Nasdaq Real Time Price', marketState: 'OVERNIGHT' });
  const wrongSymbol = { ...newest, ...falsePrice, symbol: 'ASX' };
  const wrongCurrency = { ...newest, ...falsePrice, currency: 'TWD' };
  const now = time('2026-10-23T07:59:58Z');
  assert.equal(parseYahooUmcReference(v7(unverified, wrongSymbol, wrongCurrency), now), null);
  assert.deepEqual(parseYahooUmcReference(v7(unverified, wrongSymbol, wrongCurrency, newest) + v10(older), now), {
    price: 14.31, timestamp: time('2026-10-23T07:59:47Z'), session: 'overnight', source: boats, marketOpen: true,
  });
});
