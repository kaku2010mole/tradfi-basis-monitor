import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const dataUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const helperUrl = dataUrl(stripTypeScriptTypes(await readFile(new URL('../app/lib/hkPerpPricing.ts', import.meta.url), 'utf8')));
const pricing = await import(helperUrl);
const route = async (path) => import(dataUrl(stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')).replace('"../../../lib/hkPerpPricing"', JSON.stringify(helperUrl))));
const approx = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-9, `${actual} != ${expected}`);

test('Quanto prices stay in HKD points while hedge shares follow FX; ordinary units remain unchanged', () => {
  const quanto = {perpVenue:'bitget',perpSymbol:'MINIMAXHKDUSDT',sharesPerContract:1};
  const normal = {...quanto,perpSymbol:'MINIMAXUSDT'};
  for (const fx of [7.8,7.84,7.9]) {
    assert.equal(pricing.hkPerpFairPrice(200,quanto,fx),200);
    assert.equal(pricing.hkPerpHedgeShares(quanto,fx),fx);
    approx(pricing.hkPerpFairPrice(200,normal,fx),200/fx);
    assert.equal(pricing.hkPerpHedgeShares(normal,fx),1);
    // One USDT gain per Quanto price point requires FX cash shares to hedge.
    approx(pricing.hkPerpHedgeShares(quanto,fx)/fx,1);
    approx(200 * 0.2/pricing.hkPerpHedgeShares(quanto,fx),(200/fx)*0.2);
  }
  assert.equal(pricing.isBitgetHkdQuanto({...quanto,perpVenue:'binance'}),false);
  assert.equal(pricing.hkPerpFairPrice(200,{perpVenue:'binance',perpSymbol:'HK0700USDT',sharesPerContract:7.84},7.84),200);
  for (const invalid of [0,-1,NaN,Infinity]) {
    assert.equal(pricing.hkPerpFairPrice(200,quanto,invalid),null);
    assert.ok(Number.isNaN(pricing.hkPerpHedgeShares(quanto,invalid)), 'incomplete FX input must not create a zero hedge or a -100% ADR signal');
  }
  assert.equal(pricing.hkPerpFairPrice(null,quanto,7.84),null);
  const pairs=pricing.BITGET_HK_COMPARISON_PAIRS;
  assert.equal(pairs.filter(pricing.isBitgetHkdQuanto).length,7);
  assert.ok(pairs.some(p=>p.perpSymbol==='MINIMAXUSDT'));
  assert.ok(!pairs.some(p=>p.perpSymbol==='SHEINHKDUSDT'));
});

test('live and historical HK comparisons use the right native price, depth and stale handling', async () => {
  const quotes=await route('../app/api/hk-auction/quotes/route.ts');
  const history=await route('../app/api/hk-auction/history/route.ts');
  const originalFetch=globalThis.fetch, originalPush=globalThis.__FUTU_PUSH_SNAPSHOT__, originalRelay=process.env.FUTU_RELAY_URL;
  const clock=Date.now; let now=Date.now(); const initial=now, minute=Math.floor(now/60000)*60000;
  Date.now=()=>now;
  delete process.env.FUTU_RELAY_URL;
  delete globalThis.__BITGET_BATCH_CACHE__;
  globalThis.__FUTU_PUSH_SNAPSHOT__={receivedAt:now,payload:{quotes:[{
    symbol:'HK.00100',marketState:'AUCTION',auctionPrice:200,bid:199,ask:201,bidSize:15.68,askSize:23.52,marketTimestamp:now,
  }],history:{'HK.00100':[[minute,200]]}}};
  globalThis.fetch=async (url)=>{
    const parsed=new URL(url);
    assert.equal(parsed.hostname,'api.bitget.com');
    if (parsed.pathname.endsWith('/tickers')) return Response.json({code:'00000',data:[
      {symbol:'MINIMAXHKDUSDT',bidPr:'199',askPr:'201',bidSz:'10',askSz:'20',ts:String(initial)},
      {symbol:'MINIMAXUSDT',bidPr:String(199/7.84),askPr:String(201/7.84),bidSz:'10',askSz:'20',ts:String(initial)},
    ]});
    assert.ok(parsed.pathname.endsWith('/candles'));
    return Response.json({code:'00000',data:[[String(minute),'200','200','200','200']]});
  };
  try {
    const query=new URLSearchParams({usdhkd:'7.84'});
    query.append('pair','HK.00100|MINIMAXHKDUSDT|1|bitget');
    query.append('pair','HK.00100|MINIMAXUSDT|1|bitget');
    const read=async()=>{
      const response=await quotes.GET(new Request('http://localhost/api/hk-auction/quotes?'+query));
      assert.equal(response.status,200);return response.json();
    };
    const result=await read();assert.deepEqual(result.errors,[]);
    const [q,n]=result.quotes;
    assert.equal(q.metrics.pricing,'hkd-quanto'); assert.equal(q.metrics.fairUsdt,200);
    assert.equal(q.metrics.hedgeSharesPerContract,7.84); approx(q.metrics.midBasisPct,0);
    approx(q.metrics.sellPerpBuyStock.basisPct,(199/201-1)*100);
    approx(q.metrics.buyPerpSellStock.basisPct,(201/199-1)*100);
    approx(q.metrics.sellPerpBuyStock.capacityContracts,3);
    approx(q.metrics.sellPerpBuyStock.capacityUsdt,3*199);
    approx(q.metrics.buyPerpSellStock.capacityContracts,2);
    approx(q.metrics.depthUsdt.stockBid,199*15.68/7.84);
    assert.equal(n.metrics.pricing,'usdt'); approx(n.metrics.fairUsdt,200/7.84);
    approx(n.metrics.midBasisPct,0);assert.equal(n.metrics.hedgeSharesPerContract,1);
    const response=await history.GET(new Request('http://localhost/api/hk-auction/history?stock=HK.00100&perp=MINIMAXHKDUSDT&venue=bitget&shares=1&usdhkd=7.84'));
    assert.equal(response.status,200);approx((await response.json()).points[0].value,0);
    now+=31000;
    globalThis.__FUTU_PUSH_SNAPSHOT__.receivedAt=now;
    const stale=(await read()).quotes[0];assert.equal(stale.status,'stale');
    assert.equal(stale.metrics.midBasisPct,null);assert.equal(stale.metrics.sellPerpBuyStock.basisPct,null);
  } finally {
    globalThis.fetch=originalFetch;Date.now=clock;
    if(originalPush===undefined)delete globalThis.__FUTU_PUSH_SNAPSHOT__;else globalThis.__FUTU_PUSH_SNAPSHOT__=originalPush;
    if(originalRelay===undefined)delete process.env.FUTU_RELAY_URL;else process.env.FUTU_RELAY_URL=originalRelay;
    delete globalThis.__BITGET_BATCH_CACHE__;
  }
});

test('HK auction renders all seven Quanto comparisons with honest price and hedge labels', async () => {
  const {default:worker}=await import('../dist/server/index.js');
  const response=await worker.fetch(new Request('http://localhost/hk-auction'),{ASSETS:{fetch:async()=>new Response('',{status:404})}},{waitUntil(){},passThroughOnException(){}});
  assert.equal(response.status,200);
  const html=(await response.text()).replaceAll('<!-- -->','');
  for(const pair of pricing.BITGET_HK_COMPARISON_PAIRS)assert.ok(html.includes(pair.perpSymbol));
  assert.match(html,/BITGET QUANTO/);assert.match(html,/HKD price points · USDT settlement · hedge 7\.84(?:00)? HK shares/);
  assert.doesNotMatch(html,/SHEINHKDUSDT/);
});
