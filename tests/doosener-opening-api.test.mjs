import assert from 'node:assert/strict';
import test from 'node:test';

test('DOOSENER uses two live ETFs, an explicit preopen assumption, actual session open and fixed regular close',async()=>{
  const {default:worker}=await import('../dist/server/index.js');const ctx={waitUntil(){},passThroughOnException(){}};
  const page=await worker.fetch(new Request('http://localhost/smic-opening?asset=doosener'),{ASSETS:{fetch:async()=>new Response('',{status:404})}},ctx);
  assert.equal(page.status,200);assert.match(await page.text(),/Prediction instrument/); // Same page, accessible instrument selector.
  const oldFetch=globalThis.fetch,oldClock=Date.now,oldSnapshot=globalThis.__FUTU_PUSH_SNAPSHOT__,oldState=globalThis.__DOOSENER_OPENING_MARKET__;
  let now=Date.parse('2026-10-27T12:00:00+08:00');Date.now=()=>now;globalThis.fetch=async()=>{throw new Error('History offline for this test.');};delete globalThis.__DOOSENER_OPENING_MARKET__;
  const push=async(smh=542,ewy=155,t=now,symbol='US.EWY')=>worker.fetch(new Request('http://localhost/api/hk-auction/ingest',{method:'POST',headers:{Authorization:'Bearer doosener-ingest-test'},body:JSON.stringify({generatedAt:now,quotes:[{symbol:'US.SMH',bid:smh-.1,ask:smh+.1,marketTimestamp:t},{symbol,bid:ewy-.1,ask:ewy+.1,marketTimestamp:t}]})}),{FUTU_PUSH_TOKEN:'doosener-ingest-test'},ctx);
  const get=async()=>{const r=await worker.fetch(new Request('http://localhost/api/doosener-opening'),{},ctx);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store, max-age=0');return r.json();};
  try{
    assert.equal((await push()).status,202);const pre=await get();assert.equal(pre.target.date,'2026-10-28');assert.equal(pre.phase,'preopen_assumption');assert.equal(pre.ewy.return,null);assert.equal(pre.ewy.effectiveReturn,0);assert.ok(pre.forecast);assert.equal(pre.krAnchor,null);assert.equal(pre.impliedOpen,null);
    await push(542,175);const pre2=await get();assert.equal(pre.forecast.gap,pre2.forecast.gap,'premarket EWY must not masquerade as regular-session performance');
    now=Date.parse('2026-10-27T22:00:00+08:00');await push(542,155);let current=await get();assert.equal(current.forecast,null,'no previous-session opening anchor substitution');
    const state=globalThis.__DOOSENER_OPENING_MARKET__;state.bars.EWY.push({date:'2026-10-27',open:154,close:155,complete:false});
    current=await get();assert.equal(current.phase,'live_session');assert.equal(current.ewy.open,154);assert.ok(Math.abs(current.ewy.return-100*(155/154-1))<1e-9);assert.ok(current.fresh);
    await push(543,157);const moved=await get();assert.ok(Math.abs(moved.forecast.gap-current.forecast.gap-current.model.smhBeta*(moved.signal-current.signal)-current.model.ewyBeta*(moved.ewy.return-current.ewy.return))<1e-8);
    await push(543,157,now-60_000);const stale=await get();assert.equal(stale.fresh,false);assert.ok(stale.forecast);assert.equal(stale.ewyQuote.timestamp,now-60_000);
    assert.equal((await push(543,157,now,'US.EWYUSDT')).status,400);
    await push(543,157,now+60_000);const future=await get();assert.equal(future.forecast,null);assert.equal(future.quote.price,null);
    now=Date.parse('2026-10-28T06:00:00+08:00');await push(543,157);const awaiting=await get();assert.equal(awaiting.phase,'waiting_close');assert.equal(awaiting.forecast,null);
    state.bars.EWY=state.bars.EWY.map(b=>b.date==='2026-10-27'?{...b,close:158,complete:true}:b);
    const closed=await get();assert.equal(closed.phase,'regular_close');assert.equal(closed.smhAnchor.date,'2026-10-26');assert.ok(Math.abs(closed.ewy.return-100*(158/154-1))<1e-8);
    await push(543,170);const after=await get();assert.equal(after.ewy.return,closed.ewy.return);assert.equal(after.forecast.gap,closed.forecast.gap,'EWY after-hours must not alter the regular-session factor');
  }finally{
    globalThis.fetch=oldFetch;Date.now=oldClock;if(oldSnapshot)globalThis.__FUTU_PUSH_SNAPSHOT__=oldSnapshot;else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    if(oldState)globalThis.__DOOSENER_OPENING_MARKET__=oldState;else delete globalThis.__DOOSENER_OPENING_MARKET__;
  }
});
