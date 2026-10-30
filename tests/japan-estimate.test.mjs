import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../app/lib/japanEstimate.ts', import.meta.url), 'utf8');
const { latestJapanClose, cashEstimate, fitCashModel, realQuote, freshRealQuote, parseJapanHistory } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const at = s => Date.parse(s + '+09:00');
const seed = JSON.parse(await readFile(new URL('../app/lib/data/japanCashSeed.json', import.meta.url)));
const load = async path => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await readFile(new URL(path, import.meta.url),'utf8'))).toString('base64'));
const { parseJapanSpotFx } = await load('../app/lib/japanSpotFx.ts');
const { parseKioxiaPts } = await load('../app/lib/japanPtsCash.ts');

test('cash anchor switches only at a Japanese trading-day close and survives the weekend / JPX holidays', () => {
  for (const time of ['2026-10-30T15:30:00','2026-10-31T12:00:00','2026-11-01T12:00:00','2026-11-02T15:29:59']) assert.equal(latestJapanClose(at(time)), '2026-10-30');
  assert.equal(latestJapanClose(at('2026-10-30T15:29:59')), '2026-10-29');
  assert.equal(latestJapanClose(at('2026-11-02T15:30:00')), '2026-11-02');
  assert.equal(latestJapanClose(at('2026-11-03T18:00:00')), '2026-11-02');
  assert.equal(latestJapanClose(at('2027-01-04T15:29:00')), '2026-12-30');
  assert.equal(latestJapanClose(at('2027-01-04T15:30:00')), '2027-01-04');
  assert.equal(latestJapanClose(at('2028-01-04T15:30:00')), null, 'unknown calendar cannot invent an anchor');
});

test('anchor is exact, moves are compounded from the common cash close without drift or intercept', () => {
  assert.equal(cashEstimate(1000, 13470, 13470, .3), 1000);
  const expected = 1000 * 1.05 ** .3;
  assert.ok(Math.abs(cashEstimate(1000, 13470, 13470 * 1.05, .3) - expected) < 1e-10);
  for (let i = 0; i < 100; i++) assert.equal(cashEstimate(1000, 13470, 13470 * 1.05, .3), expected);
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(cashEstimate(1000, bad, 13470, .3), null);
});

test('actual cash sample has aligned dates, bounded rolling calibration and genuine forward-only error', () => {
  const k = seed.histories['285A'].bars, y = seed.histories['8035'].bars;
  const model = fitCashModel(k, y, '2026-10-30');
  assert.equal(model.n, 126); assert.equal(model.testN, 60); assert.equal(model.through, '2026-10-30');
  assert.ok(model.maePct > 0 && model.maePct < 20); assert.ok(Math.abs(model.correlation) <= 1);
  const before = fitCashModel(k, y, '2026-10-20');
  const poisoned = [...y.map(b => b.date > '2026-10-20' ? {...b,close:b.close * 200} : b), {date:'2026-11-02',close:1e9}];
  assert.deepEqual(fitCashModel(k, poisoned, '2026-10-20'), before, 'later stock prices cannot alter a historical fit or backtest');
  const dates = k.map(b => b.date), km = new Map(k.map(b => [b.date,b.close])), ym = new Map(y.map(b => [b.date,b.close]));
  const returns = dates.slice(1).map((d,i) => [Math.log(km.get(d)/km.get(dates[i])),Math.log(ym.get(d)/ym.get(dates[i]))]);
  const last = returns.slice(-126);
  const beta = last.reduce((sum,[x,y])=>sum+x*y,0)/last.reduce((sum,[x])=>sum+x*x,0);
  assert.ok(Math.abs(model.beta-beta)<1e-12);
  const errors = returns.slice(-60).map(([x,y],j) => {
    const i=returns.length-60+j, train=returns.slice(Math.max(0,i-126),i);
    const b=train.reduce((s,[a,c])=>s+a*c,0)/train.reduce((s,[a])=>s+a*a,0);
    return Math.abs(Math.expm1(y)-Math.expm1(b*x))*100;
  });
  assert.ok(Math.abs(model.maePct-errors.reduce((a,b)=>a+b,0)/60)<1e-12);
});

test('live status uses original market time, rejects future/crossed quotes, retains stale values', () => {
  const now = at('2026-10-30T17:00:00');
  const record = {bid:13469,ask:13471,bidSize:10,askSize:20,marketTimestamp:now};
  const quote = realQuote(record,'real cash',now);
  assert.equal(quote.price,13470); assert.equal(quote.kind,'mid'); assert.equal(freshRealQuote(quote,now),true);
  const stale = realQuote({...record,marketTimestamp:now-100_000},'real cash',now);
  assert.equal(stale.price,13470); assert.equal(stale.timestamp,now-100_000); assert.equal(freshRealQuote(stale,now),false);
  assert.equal(realQuote({...record,marketTimestamp:now+6000},'real cash',now),null);
  assert.equal(realQuote({...record,bid:14000,last:13470},'real cash',now),null);
  const last = realQuote({last:13470,marketTimestamp:now},'real cash',now);
  assert.equal(last.kind,'last');
});

test('a current intraday bar cannot become a close, and wrong security / currency is rejected', () => {
  const now=at('2026-10-30T15:31:00');
  const bars=seed.histories['285A'].bars;
  const chart={chart:{result:[{meta:{symbol:'285A.T',currency:'JPY',instrumentType:'EQUITY',regularMarketTime:at('2026-10-30T15:20:00')/1000},timestamp:bars.map(b=>at(b.date+'T09:00:00')/1000),indicators:{quote:[{close:bars.map(b=>b.close)}]}}]}};
  assert.equal(parseJapanHistory(chart,'285A',now).bars.at(-1).date,'2026-10-29');
  assert.equal(parseJapanHistory(chart,'285A',at('2026-11-01T12:00:00')).bars.at(-1).date,'2026-10-29','a stale intraday response is still not a close on Sunday');
  chart.chart.result[0].meta.regularMarketTime=at('2026-10-30T15:30:00')/1000;
  assert.equal(parseJapanHistory(chart,'285A',now).bars.at(-1).date,'2026-10-30');
  assert.equal(parseJapanHistory(chart,'8035',now),null);
  chart.chart.result[0].meta.currency='USD'; assert.equal(parseJapanHistory(chart,'285A',now),null);
});

test('PTS cash uses the dated current-price row and stays explicitly delayed, even if recently fetched', () => {
  const html='<link rel="canonical" href="https://kabutan.jp/stock/?code=285A" /><span class="kabuka">13,470円</span><div class="stock_pts_div" data-mode="1"><table><tr><th scope="row">高値</th><td>14,490</td><td>(<time datetime="2026-10-29 18:07">18:07</time>)</td></tr><tr><th scope="row">現在値</th><td>13,650</td><td>(<time datetime="2026-10-30 16:29">16:29</time>)</td></tr></table><a href="https://www.japannext.co.jp/ja">source</a></div><!--stock_pts_div-->';
  const now=at('2026-10-30T16:50:00'), q=parseKioxiaPts(html,now);
  assert.equal(q.price,13650);assert.equal(q.timestamp,at('2026-10-30T16:29:00'));assert.equal(q.delayMinutes,15);assert.equal(freshRealQuote(q,q.timestamp+1000),false);
  assert.equal(parseKioxiaPts(html.replace('現在値','始値'),now),null);
  assert.equal(parseKioxiaPts(html.replace('code=285A','code=8035'),now),null);
  assert.equal(parseKioxiaPts(html,at('2026-10-30T16:28:00')),null);
  assert.equal(parseKioxiaPts(html,at('2026-11-07T16:50:00')),null);
});

test('spot FX reference verifies currency instrument and original quote time; a contract index cannot substitute', () => {
  const now=at('2026-10-30T17:00:00');
  const payload={chart:{result:[{meta:{symbol:'JPY=X',currency:'JPY',instrumentType:'CURRENCY',regularMarketPrice:157.583,regularMarketTime:(now-120000)/1000}}]}};
  const q=parseJapanSpotFx(payload,now);assert.equal(q.price,157.583);assert.equal(q.timestamp,now-120000);assert.equal(freshRealQuote(q,now),false);
  for (const patch of [{symbol:'USDJPYUSDT'},{instrumentType:'FUTURE'},{currency:'USD'},{regularMarketTime:(now+6000)/1000},{regularMarketPrice:0}]) {
    assert.equal(parseJapanSpotFx({chart:{result:[{meta:{...payload.chart.result[0].meta,...patch}}]}},now),null);
  }
});
