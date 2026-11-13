import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const encode = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64')}`;
const read = file => readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
const fundSeed = JSON.parse(await read('data/diskDramHoldings.json'));
const navSeed = JSON.parse(await read('data/diskSyntheticNavSeed.json'));
const sessions = encode(await read('lib/smicOpening.ts'));
const fundModule = encode((await read('lib/diskDramHoldings.ts')).replace('import seed from "../data/diskDramHoldings.json";', `const seed = ${JSON.stringify(fundSeed)};`));
const constituentModule = encode((await read('lib/diskConstituentMarket.ts'))
  .replace('from "./smicOpening"', `from ${JSON.stringify(sessions)}`)
  .replace('from "./diskDramHoldings"', `from ${JSON.stringify(fundModule)}`));
const pure = encode(await read('lib/diskSyntheticNav.ts'));
const source = (await read('lib/diskSyntheticNavMarket.ts'))
  .replace('import reviewed from "../data/diskSyntheticNavSeed.json";', `const reviewed = ${JSON.stringify(navSeed)};`)
  .replaceAll('from "./smicOpening"', `from ${JSON.stringify(sessions)}`)
  .replaceAll('from "./diskDramHoldings"', `from ${JSON.stringify(fundModule)}`)
  .replaceAll('from "./diskConstituentMarket"', `from ${JSON.stringify(constituentModule)}`)
  .replaceAll('from "./diskSyntheticNav"', `from ${JSON.stringify(pure)}`);
const { parseTemaSyntheticNav, parseSyntheticNavBitgetQuotes, syntheticNavHistoricalCash,
  syntheticNavHistoricalFx, syntheticNavHoldingsComplete, createDiskSyntheticNavMarketClient } = await import(encode(source));
const at = value => Date.parse(value);
const now = at('2026-11-11T10:00:00+08:00');
const html = (date = 'November 09, 2026', nav = '23.35', assets = '42,035,159', count = 18) =>
  `<h3>Fund Details</h3>As of ${date}<p>AUM $${assets}</p><p>Shares Outstanding 1,800,000</p><p># of Holdings ${count}</p>` +
  `<h3>DISK NAV / Market Price</h3><p>NAV $${nav}</p><p>Market Price $24.45</p>As of ${date}`;

test('issuer NAV uses a dated published NAV and consistent same-date AUM/units only', () => {
  const nav = parseTemaSyntheticNav(html(), now);
  assert.equal(nav.date, '2026-11-09');
  assert.equal(nav.at, at('2026-11-10T05:00:00+08:00'));
  assert.equal(nav.nav, 42035159 / 1800000);
  assert.equal(parseTemaSyntheticNav(html('November 09, 2026', '23.35', '46,541,377'), now).nav, 23.35,
    'inconsistent holdings valuation cannot become an inferred fund NAV');
  const wrongDate = html().replace('Fund Details</h3>As of November 09', 'Fund Details</h3>As of November 06');
  assert.equal(parseTemaSyntheticNav(wrongDate, now).nav, 23.35);
  assert.equal(parseTemaSyntheticNav(html(), at('2026-11-18T10:00:00+08:00')), null);
  assert.equal(parseTemaSyntheticNav(html('November 12, 2026'), now), null);
  assert.equal(parseTemaSyntheticNav('<p>NAV $25.00</p>', now), null);
});

test('stock perp quote parser excludes crypto ticker collisions, crossed/empty books, expired and future clocks', () => {
  const quote = (symbol, changes = {}) => ({ symbol, bidPr: '100', askPr: '102', bidSz: '2', askSz: '3', ts: String(now - 1000), ...changes });
  const parsed = parseSyntheticNavBitgetQuotes({ code: '00000', data: [
    quote('STXUSDT'), quote('STXSTOCKUSDT'), quote('MUUSDT', { ts: String(now - 46000) }),
    quote('SNDKUSDT', { askPr: '99' }), quote('WDCUSDT', { askSz: '0' }), quote('AEHRUSDT', { ts: String(now + 6000) }),
  ] }, now);
  assert.deepEqual([...parsed.keys()], ['STXSTOCKUSDT']);
  assert.equal(parsed.get('STXSTOCKUSDT').price, 101);
  assert.equal(parsed.get('STXSTOCKUSDT').at, now - 1000);
});

test('historical baselines are native CASH levels completed before the official NAV, never current-day or perp close levels', () => {
  const nav = parseTemaSyntheticNav(html(), now);
  const chart = { meta: { symbol: '285A.T', currency: 'JPY' },
    timestamp: [at('2026-11-09T09:00:00+09:00') / 1000, at('2026-11-10T09:00:00+09:00') / 1000],
    indicators: { quote: [{ close: [8302, 99999] }] } };
  const result = syntheticNavHistoricalCash(chart, { symbol: '285A.T', currency: 'JPY', name: 'Kioxia', weight: 1 }, nav);
  assert.equal(result.price, 8302);
  assert.equal(result.at, at('2026-11-09T15:30:00+09:00'));
  const rates = { meta: { currency: 'CNY' },
    timestamp: [(nav.at - 65 * 60000) / 1000, nav.at / 1000], indicators: { quote: [{ close: [6.6727, 99] }] } };
  const fx = syntheticNavHistoricalFx(rates, 'CNY', nav.at);
  assert.equal(fx.price, 6.6727);
  assert.equal(fx.at, nav.at - 60 * 60000, 'the explicitly dated CNY04:00 reference remains one hour old');
});

test('historical FX accepts the genuine CNY session close without widening other reference windows', () => {
  const nav = parseTemaSyntheticNav(html('November 10, 2026', '24.00', '43,200,000'), now);
  const chart = (currency, minutesBefore) => ({ meta: { currency },
    timestamp: [(nav.at - (minutesBefore + 5) * 60000) / 1000],
    indicators: { quote: [{ close: [6.67] }] } });
  const closed = syntheticNavHistoricalFx(chart('CNY', 125), 'CNY', nav.at);
  assert.equal(closed.price, 6.67);
  assert.equal(closed.at, at('2026-11-11T02:55:00+08:00'), 'the original completed close timestamp is preserved');
  assert.equal(syntheticNavHistoricalFx(chart('CNY', 145), 'CNY', nav.at), null,
    'an older intraday CNY observation cannot impersonate the closing window');
  assert.equal(syntheticNavHistoricalFx(chart('JPY', 125), 'JPY', nav.at), null,
    'the CNY session exception does not extend the general 90-minute FX window');
  const future = chart('CNY', -5);
  assert.equal(syntheticNavHistoricalFx(future, 'CNY', nav.at), null);
});

test('issuer stock count and weight completeness reject a truncated low-weight final holding', () => {
  assert.equal(syntheticNavHoldingsComplete(fundSeed.DISK, html()), true);
  assert.equal(syntheticNavHoldingsComplete({ ...fundSeed.DISK, holdings: fundSeed.DISK.holdings.slice(0, -1) }, html()), false);
  assert.equal(syntheticNavHoldingsComplete({ ...fundSeed.DISK, holdings: [...fundSeed.DISK.holdings.slice(0, -1), fundSeed.DISK.holdings[0]] }, html()), false);
});

test('shared background refresh uses cached NAV cash levels and expires failed perp quotes without extending their clocks', async () => {
  let clock = now, offline = false, navDate = 'November 09, 2026', calls = [];
  const symbols = ['MU', 'SNDK', 'WDC', 'STX', 'AEHR'];
  const nav = parseTemaSyntheticNav(html(), clock);
  const holdings = { asOf: '2026-11-09', source: 'issuer', cashWeight: 0,
    holdings: symbols.map(symbol => ({ symbol, name: symbol, currency: 'USD', weight: .2, quantity: 1 })) };
  const seed = { nav, holdings, baselines: Object.fromEntries(symbols.map(symbol => [symbol,
    { currency: 'USD', native: 100, at: nav.at, fx: 1, fxAt: nav.at }])) };
  const csv = ['holdings_date,ticker,cusip,proper_name,shares,market_value,percent_of_nav,is_cash,country,sector',
    ...symbols.map(symbol => `2026-11-09,${symbol},,${symbol},1,100,0.2,0,US,IT`)].join('\n');
  const fetcher = async input => {
    const path = String(input); calls.push(path);
    if (offline) throw Error('offline');
    if (path.includes('/tickers?')) return Response.json({ code: '00000', data: symbols.map(symbol => ({
      symbol: symbol === 'STX' ? 'STXSTOCKUSDT' : `${symbol}USDT`, bidPr: '109', askPr: '111', bidSz: '10', askSz: '10', ts: String(clock),
    })) });
    if (path === 'https://temaetfs.com/disk') return new Response(html(navDate, navDate.includes('10,') ? '24.00' : '23.35', navDate.includes('10,') ? '43,200,000' : '42,035,159', 5) +
      '<a href="https://temaetfs.com/hubfs/Website/Holdings/DISK-holdings-11092026.csv">CSV</a>');
    if (path.includes('DISK-holdings-')) return new Response(csv);
    throw Error('No historical quote available ' + path);
  };
  const get = createDiskSyntheticNavMarketClient({ seed, fetcher, clock: () => clock });
  get(); for (let i = 0; i < 20; i++) get();
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const result = get();
  assert.equal(result.status, 'ready');
  assert.ok(Math.abs(result.nav - nav.nav * 1.1) < 1e-10);
  assert.equal(calls.length, 3, 'one ticker request, one issuer page and one holdings file are shared');
  assert.equal(result.rows[0].baseUsd, 100);
  assert.equal(result.rows[0].currentUsd, 110);
  offline = true; clock += 46000;
  const expired = get();
  assert.equal(expired.status, 'partial'); assert.equal(expired.nav, null);
  assert.equal(expired.rows[0].quoteAt, now, 'failed refresh cannot stamp old prices as new');
  await settle();
  offline = false; navDate = 'November 10, 2026'; clock += 3600001;
  get(); await settle(); get(); await settle();
  const rolled = get();
  assert.equal(rolled.base.date, '2026-11-09');
  assert.equal(rolled.status, 'ready');
  assert.ok(Math.abs(rolled.nav - nav.nav * 1.1) < 1e-10);
  assert.ok(rolled.rows.every(row => row.baseUsd === 100), 'a newer incomplete NAV cannot replace the coherent previous baseline');
  assert.match(rolled.reasons.join(' '), /pending|awaiting|incomplete|waiting/i);
  const tickerRequests = calls.filter(path => path.includes('/tickers?'));
  assert.ok(new Set(tickerRequests).size > 1, 'each live refresh bypasses upstream edge cache');
});

test('a newer NAV is adopted atomically after every matching stock and FX baseline is complete', async () => {
  let clock = now, newNav = false, offline = false, cnyLag = 145;
  const symbols = ['MU', 'SNDK', 'WDC', 'AEHR', '688825.SS'];
  const usdAvailable = new Set(['MU', 'SNDK']);
  const weights = [.1, .2, .3, .25, .15];
  const nav = parseTemaSyntheticNav(html(), clock);
  const nextNav = parseTemaSyntheticNav(html('November 10, 2026', '24.00', '43,200,000'), clock);
  const holdings = { asOf: nav.date, source: 'issuer', cashWeight: 0,
    holdings: symbols.map(symbol => ({ symbol, name: symbol, currency: symbol === '688825.SS' ? 'CNY' : 'USD', weight: .2, quantity: 1 })) };
  const seed = { nav, holdings, baselines: Object.fromEntries(holdings.holdings.map(h => [h.symbol,
    { currency: h.currency, native: h.currency === 'CNY' ? 600 : 100,
      at: h.currency === 'CNY' ? at('2026-11-09T15:00:00+08:00') : nav.at, fx: h.currency === 'CNY' ? 6 : 1, fxAt: nav.at }])) };
  const csv = date => ['holdings_date,ticker,cusip,proper_name,shares,market_value,percent_of_nav,is_cash,country,sector',
    ...symbols.map((symbol, i) => `${date},${symbol === '688825.SS' ? '688825 C1' : symbol},,${symbol === '688825.SS' ? 'CXMT' : symbol},1,100,${newNav ? weights[i] : .2},0,,IT`)].join('\n');
  const fetcher = async input => {
    if (offline) throw Error('offline');
    const path = String(input);
    if (path.includes('/tickers?')) return Response.json({ code: '00000', data: symbols.map(symbol => ({
      symbol: symbol === '688825.SS' ? 'CXMTUSDT' : `${symbol}USDT`, bidPr: 109, askPr: 111, bidSz: 2, askSz: 2, ts: clock,
    })) });
    if (path === 'https://temaetfs.com/disk') return new Response((newNav
      ? html('November 10, 2026', '24.00', '43,200,000', 5) : html(undefined, undefined, undefined, 5)) +
      `<a href="https://temaetfs.com/hubfs/Website/Holdings/DISK-holdings-${newNav ? '11102026' : '11092026'}.csv">CSV</a>`);
    if (path.includes('DISK-holdings-')) return new Response(csv(newNav ? nextNav.date : nav.date));
    const symbol = decodeURIComponent(/\/chart\/([^?]+)/.exec(path)?.[1] ?? '');
    if (symbol === 'CNY=X') return Response.json({ chart: { result: [{ meta: { symbol, currency: 'CNY' },
      timestamp: [(nextNav.at - (cnyLag + 5) * 60000) / 1000], indicators: { quote: [{ close: [6] }] } }] } });
    if (symbols.includes(symbol) && (symbol === '688825.SS' || usdAvailable.has(symbol))) {
      const chinese = symbol === '688825.SS';
      return Response.json({ chart: { result: [{ meta: { symbol, currency: chinese ? 'CNY' : 'USD' },
        timestamp: [(chinese ? at('2026-11-10T09:30:00+08:00') : nextNav.at) / 1000],
        indicators: { quote: [{ close: [chinese ? 1200 : 200] }] } }] } });
    }
    throw Error('Candidate historical baseline not available yet');
  };
  const get = createDiskSyntheticNavMarketClient({ seed, fetcher, clock: () => clock });
  const snapshots = [];
  const settle = async () => { for (let i = 0; i < 16; i++) {
    await new Promise(resolve => setImmediate(resolve)); snapshots.push(get());
  } };
  get(); await settle();
  const initial = get();
  assert.equal(initial.status, 'ready');
  assert.equal(initial.base.date, nav.date);
  newNav = true; clock += 3600001;
  get(); await settle();
  const missingStocks = get();
  assert.equal(missingStocks.status, 'ready');
  assert.equal(missingStocks.base.date, nav.date);
  assert.ok(missingStocks.rows.every(row => row.baseUsd === 100 && row.weight === .2));
  assert.match(missingStocks.reasons.join(' '), /pending|awaiting|incomplete|waiting/i);
  usdAvailable.add('WDC'); usdAvailable.add('AEHR'); clock += 61000;
  get(); await settle();
  const invalidFx = get();
  assert.equal(invalidFx.base.date, nav.date, 'having all native stock prices cannot adopt an invalid FX baseline');
  assert.equal(invalidFx.status, 'ready');
  assert.ok(invalidFx.rows.every(row => row.baseUsd === 100 && row.weight === .2));
  offline = true; clock += 46000;
  const expiredPerps = get();
  assert.equal(expiredPerps.base.date, nav.date);
  assert.equal(expiredPerps.status, 'partial');
  assert.equal(expiredPerps.nav, null, 'retaining a coherent baseline cannot revive expired live quotes');
  assert.ok(expiredPerps.rows.every(row => row.quoteAt === clock - 46000));
  await settle();
  offline = false; cnyLag = 125; clock += 61000;
  get(); await settle();
  const adopted = get();
  assert.equal(adopted.status, 'ready', adopted.reasons.join('; '));
  assert.equal(adopted.base.date, nextNav.date);
  assert.equal(adopted.base.holdingsAsOf, nextNav.date);
  assert.equal(adopted.base.nav, 24);
  assert.ok(Math.abs(adopted.nav - 13.2) < 1e-10);
  assert.deepEqual(adopted.rows.map(row => row.weight), weights);
  assert.ok(adopted.rows.every(row => row.baseUsd === 200));
  assert.equal(adopted.rows.find(row => row.currency === 'CNY').baseFxAt, nextNav.at - 125 * 60000);
  for (const snapshot of snapshots) {
    if (snapshot.base.date === nav.date) assert.ok(snapshot.rows.every(row => row.baseUsd === 100 && row.weight === .2));
    else {
      assert.equal(snapshot.base.date, nextNav.date);
      assert.ok(snapshot.rows.every(row => row.baseUsd === 200));
      assert.deepEqual(snapshot.rows.map(row => row.weight), weights);
    }
  }
});

test('completed Taiwan cash close stays honestly timestamped and cannot carry into the next active session', async () => {
  let clock = at('2026-11-11T16:00:00+08:00'), offline = false;
  const nav = parseTemaSyntheticNav(html(), clock), symbols = ['MU', 'SNDK', 'WDC', 'AEHR'];
  const holdings = { asOf: nav.date, source: 'issuer', cashWeight: 0, holdings: [
    ...symbols.map(symbol => ({ symbol, name: symbol, currency: 'USD', weight: .2, quantity: 1 })),
    { symbol: '2337.TW', name: 'Macronix', currency: 'TWD', weight: .2, quantity: 1 },
  ] };
  const seed = { nav, holdings, baselines: Object.fromEntries(holdings.holdings.map(h => [h.symbol,
    { currency: h.currency, native: h.currency === 'TWD' ? 83.3 : 100,
      at: h.currency === 'TWD' ? at('2026-11-09T13:30:00+08:00') : nav.at,
      fx: h.currency === 'TWD' ? 32.766 : 1, fxAt: nav.at }])) };
  const tradeAt = at('2026-11-11T13:30:02+08:00');
  const csv = ['holdings_date,ticker,cusip,proper_name,shares,market_value,percent_of_nav,is_cash,country,sector',
    ...symbols.map(symbol => `2026-11-09,${symbol},,${symbol},1,100,0.2,0,US,IT`),
    '2026-11-09,2337 TT,,Macronix,1,100,0.2,0,TW,IT'].join('\n');
  const fetcher = async input => {
    if (offline) throw Error('offline');
    const path = String(input);
    if (path.includes('/tickers?')) return Response.json({ code: '00000', data: symbols.map(s => ({ symbol: `${s}USDT`, bidPr: 109, askPr: 111, bidSz: 2, askSz: 2, ts: clock })) });
    if (path === 'https://temaetfs.com/disk') return new Response(html(undefined, undefined, undefined, 5) + '<a href="https://temaetfs.com/hubfs/Website/Holdings/DISK-holdings-11092026.csv">CSV</a>');
    if (path.includes('DISK-holdings-')) return new Response(csv);
    if (path.includes('/chart/2337.TW')) return Response.json({ chart: { result: [{ meta: {
      symbol: '2337.TW', currency: 'TWD', regularMarketPrice: 82.7, regularMarketTime: tradeAt / 1000,
      currentTradingPeriod: { regular: { start: at('2026-11-11T09:00:00+08:00') / 1000, end: at('2026-11-11T13:30:00+08:00') / 1000 } },
    } }] } });
    if (path.includes('/chart/TWD%3DX')) return Response.json({ chart: { result: [{ meta: {
      symbol: 'TWD=X', currency: 'TWD', regularMarketPrice: 32.835, regularMarketTime: (clock-1000) / 1000,
    } }] } });
    throw Error('Missing optional source');
  };
  const get = createDiskSyntheticNavMarketClient({ seed, fetcher, clock: () => clock });
  get(); for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  const ready = get(); assert.equal(ready.status, 'ready');
  const taiwan = ready.rows.find(row => row.symbol === '2337.TW');
  assert.equal(taiwan.quoteAt, tradeAt);
  assert.match(taiwan.reference, /verified completed-session/);
  assert.ok(Math.abs(taiwan.currentUsd - 82.7/32.835) < 1e-12);
  offline = true; clock = at('2026-11-12T10:00:00+08:00');
  const nextSession = get();
  assert.equal(nextSession.status, 'partial'); assert.equal(nextSession.nav, null);
  assert.equal(nextSession.rows.find(row => row.symbol === '2337.TW').reference, null);
});
