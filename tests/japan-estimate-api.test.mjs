import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('independent Japan panel uses cash anchors and real FX, with contract quotes isolated to comparison', async () => {
  const {default:worker}=await import('../dist/server/index.js');
  const ctx={waitUntil(){},passThroughOnException(){}};
  const page=await worker.fetch(new Request('http://localhost/japan-estimate'),{ASSETS:{fetch:async()=>new Response('',{status:404})}},ctx);
  assert.equal(page.status,200); assert.match(await page.text(),/日股估计价格/);
  const protectedApi=await worker.fetch(new Request('http://localhost/api/japan-estimate'),{SITE_PASSWORD:'test-password'},ctx);
  assert.equal(protectedApi.status,401);
  const original={fetch:globalThis.fetch,now:Date.now,snapshot:globalThis.__FUTU_PUSH_SNAPSHOT__,state:globalThis.__JAPAN_ESTIMATE__,fx:globalThis.__JAPAN_SPOT_FX__,pts:globalThis.__JAPAN_PTS_CASH__};
  let now=Date.parse('2026-10-30T18:00:00+09:00'), contractPrice=75, publishClose=false;
  const seed=JSON.parse(await readFile(new URL('../app/lib/data/japanCashSeed.json',import.meta.url)));
  Date.now=()=>now;
  globalThis.fetch=async url=>{
    if (String(url).includes('api.bitget.com')) return Response.json({code:'00000',data:[{symbol:'TOKYOELUSDT',bidPr:String(contractPrice-0.01),askPr:String(contractPrice+0.01),bidSz:'10',askSz:'10',indexPrice:'9999999',ts:String(now)}]});
    const code=String(url).match(/chart\/(\w+)\.T\?/i)?.[1];
    if(publishClose && code){
      const bars=[...seed.histories[code].bars,{date:'2026-11-02',close:code==='285A'?14000:10000}];
      return Response.json({chart:{result:[{meta:{symbol:code+'.T',currency:'JPY',instrumentType:'EQUITY',regularMarketTime:Date.parse('2026-11-02T15:30:00+09:00')/1000},timestamp:bars.map(b=>Date.parse(b.date+'T09:00:00+09:00')/1000),indicators:{quote:[{close:bars.map(b=>b.close)}]}}]}});
    }
    throw Error('Deliberately offline; exercise dated cash seed');
  };
  delete globalThis.__JAPAN_ESTIMATE__;
  delete globalThis.__JAPAN_SPOT_FX__;delete globalThis.__JAPAN_PTS_CASH__;
  const push=(k,fx,t=now)=>{globalThis.__FUTU_PUSH_SNAPSHOT__={receivedAt:now,payload:{quotes:[{symbol:'TSE.285A',bid:k-1,ask:k+1,bidSize:10,askSize:10,marketTimestamp:t,source:'IBKR real stock'},{symbol:'FX.USDJPY',bid:fx-.001,ask:fx+.001,bidSize:10,askSize:10,marketTimestamp:t,source:'IBKR real FX'}]}};};
  const get=async()=>{const response=await worker.fetch(new Request('http://localhost/api/japan-estimate'),{},ctx);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store, max-age=0');return response.json();};
  const tokyo=p=>p.rows.find(r=>r.code==='8035');
  try {
    push(13470,150);
    const reset=await get();assert.equal(reset.anchorDate,'2026-10-30');assert.equal(reset.anchorReady,true);assert.equal(reset.rows.length,11);
    assert.equal(tokyo(reset).yen,9514);assert.equal(tokyo(reset).usd,9514/150);assert.ok(tokyo(reset).deviationPct>0);
    push(14143.5,150);const moved=await get();assert.ok(tokyo(moved).yen>tokyo(reset).yen);
    assert.ok(Math.abs(tokyo(moved).yen-9514*1.05**tokyo(moved).model.beta)<1e-8);
    now+=2100;contractPrice=30;push(14143.5,150);const changedContract=await get();
    assert.equal(tokyo(changedContract).yen,tokyo(moved).yen);assert.equal(tokyo(changedContract).usd,tokyo(moved).usd);assert.ok(tokyo(changedContract).deviationPct<0);
    now+=2100;push(14143.5,160);const fx=await get();assert.equal(tokyo(fx).yen,tokyo(moved).yen);assert.equal(tokyo(fx).usd,tokyo(fx).yen/160);
    now+=100_000;push(14143.5,160,now-100_000);const stale=await get();assert.equal(stale.kioxia.fresh,false);assert.equal(tokyo(stale).status,'估价已冻结');assert.equal(tokyo(stale).deviationPct,null);assert.equal(tokyo(stale).yen,tokyo(fx).yen);
    now=Date.parse('2026-11-01T12:00:00+09:00');const weekend=await get();assert.equal(weekend.anchorDate,'2026-10-30');assert.equal(tokyo(weekend).status,'估价已冻结');
    now=Date.parse('2026-11-02T15:30:00+09:00');const pending=await get();assert.equal(pending.anchorDate,'2026-11-02');assert.equal(pending.anchorReady,false);assert.equal(tokyo(pending).yen,null);assert.equal(tokyo(pending).close,null);assert.equal(tokyo(pending).status,'等待本次收盘价');
    await new Promise(resolve=>setImmediate(resolve));
    now+=61_000;publishClose=true;await get();await new Promise(resolve=>setImmediate(resolve));
    const newClose=await get();assert.equal(newClose.anchorDate,'2026-11-02');assert.equal(newClose.anchorReady,true);assert.equal(tokyo(newClose).close,10000);assert.equal(tokyo(newClose).yen,10000,'new close resets the anchor; the previous Friday quote cannot move it');assert.equal(newClose.kioxia.quote,null);
  } finally {
    globalThis.fetch=original.fetch;Date.now=original.now;
    if(original.snapshot)globalThis.__FUTU_PUSH_SNAPSHOT__=original.snapshot;else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    if(original.state)globalThis.__JAPAN_ESTIMATE__=original.state;else delete globalThis.__JAPAN_ESTIMATE__;
    if(original.fx)globalThis.__JAPAN_SPOT_FX__=original.fx;else delete globalThis.__JAPAN_SPOT_FX__;
    if(original.pts)globalThis.__JAPAN_PTS_CASH__=original.pts;else delete globalThis.__JAPAN_PTS_CASH__;
  }
});
