// Offline concurrent-read benchmark. No live venue traffic, no changed polling.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const mode=process.argv[2];
if (!mode) {
  const results={before:[],after:[]};
  for(let run=0;run<5;run++)for(const side of run%2 ? ['after','before'] : ['before','after']) {
    const child=spawnSync(process.execPath,['--expose-gc',import.meta.filename,side],{encoding:'utf8'});
    if(child.status!==0)throw new Error(child.stderr);
    results[side].push(JSON.parse(child.stdout));
  }
  const median=(xs)=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  const summary=Object.fromEntries(Object.entries(results).map(([side,rows])=>[side,Object.fromEntries(['cpuMs','peakRssMiB','networkCalls','parses'].map(key=>[key,median(rows.map(r=>r[key]))]))]));
  console.log(JSON.stringify({clients:8,polls:120,quotesPerPayload:1000,identicalValues:true,...summary,
    reductionPercent:Object.fromEntries(['cpuMs','peakRssMiB','networkCalls','parses'].map(key=>[key,100*(1-summary.after[key]/summary.before[key])]))}));
} else {
  const source=stripTypeScriptTypes(await readFile(new URL('../app/lib/publicBinanceJson.ts',import.meta.url),'utf8'));
  const {publicBinanceJson}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const url='https://fapi.binance.com/fapi/v1/ticker/bookTicker';
  const payload=JSON.stringify(Array.from({length:1000},(_,i)=>({symbol:'TEST'+i,bidPrice:'79.123456789',askPrice:'79.987654321',bidQty:'100.01',askQty:'101.23',time:1792573200000})));
  let networkCalls=0,parses=0;
  globalThis.fetch=async()=>{networkCalls++;return {ok:true,json:async()=>{parses++;return JSON.parse(payload);}};};
  const read=mode==='after'?()=>publicBinanceJson(url,7000):async()=>{
    const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error('HTTP failure');
    return await response.json();
  };
  globalThis.gc?.();const start=process.cpuUsage();
  for(let poll=0;poll<120;poll++) {
    const rows=await Promise.all(Array.from({length:8},read));
    for(const data of rows){assert.equal(data.length,1000);assert.equal(data[0].time,1792573200000);assert.equal(data[999].askPrice,'79.987654321');}
  }
  const cpu=process.cpuUsage(start);
  console.log(JSON.stringify({cpuMs:(cpu.user+cpu.system)/1000,peakRssMiB:process.resourceUsage().maxRSS/1024,networkCalls,parses}));
}
