// Reproducible local render benchmark, NOT a browser/Render-server memory claim.
// Uses the real component code and identical synthetic public quote shapes.
// Run: node scripts/benchmark-stock-render.mjs [baseline-git-ref]
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const mode = process.argv[2];
if (mode !== "--worker") {
  const baseline = mode || "75ec232";
  const runs = [];
  for (let i=0;i<3;i++) for (const version of [baseline, "working"]) {
    runs.push(JSON.parse(execFileSync(process.execPath, ["--expose-gc",fileURLToPath(import.meta.url),"--worker",version], {cwd:root,encoding:"utf8",env:{...process.env,NODE_ENV:"production"}})));
  }
  const median = (values) => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const summaries = [baseline,"working"].map(version=>({version,...Object.fromEntries(["cpuMs","wallMs","peakRssMiB","rssGrowthMiB","peakHeapMiB","heapAfterGcMiB","formatters","htmlBytes"].map(k=>[k,median(runs.filter(r=>r.version===version).map(r=>r[k]))]))}));
  console.log(JSON.stringify({method:"Node production React SSR, 11 KRX (13 venue quotes) + 12 TSE rows + Taiwan panel; same quotes, previous closes and FX; 5 warmup renders + 120 measured renders; 3 independent processes per version; formatter count includes legacy Number.toLocaleString calls and Intl constructions; no network, DOM layout or browser GPU included",runs,summaries},null,2));
} else {
  const version = process.argv[3], React = require("react"), {renderToString} = require("react-dom/server");
  const now = Date.parse("2026-10-23T06:00:00Z");
  const rows = Array.from({length:23},(_,i)=>({code:String(10000+i),name:`Benchmark stock ${i+1}`,market:i<11?"KRX":"TSE",currency:i<11?"KRW":"JPY",session:"REGULAR",sharesPerPerp:1,
    cashBidKrw:i<11?135000:15000,cashAskKrw:i<11?135100:15010,cashLast:i<11?135050:15005,cashBidQty:100,cashAskQty:200,cashUpdatedAt:now,cashBidUsd:99.9,cashAskUsd:100.1,mappingNote:null,
    previousClose:i<11?{price:135000,source:"fixture",observedAt:now,sessionDate:"2026-10-23"}:null,
    venues:(i<2?["Bitget","Binance"]:["Bitget"]).map(venue=>({venue,symbol:`QUOTE${i}USDT`,bid:101,ask:102,bidQty:10,askQty:20,updatedAt:now,buyKoreaSellPerp:1,buyPerpSellKorea:-2})),
    adr:i>=11&&i<16?{symbol:`ADR${i}`,sharesPerAdr:1,source:"fixture",marketState:"REGULAR",bid:100,ask:100.1,last:100,bidQty:10,askQty:10,updatedAt:now}:null}));
  const payload={rows,krwConversion:{rate:1350.123,source:"fixture",updatedAt:now,live:true,date:null},fx:{source:"fixture",bid:1349,ask:1351,last:1350,updatedAt:now},yenFx:{source:"fixture",bid:149.9,ask:150.1,last:150,updatedAt:now},sessions:{KRX:"REGULAR",TSE:"REGULAR",US:"REGULAR"},posley:{state:"live",error:"",missing:[],source:"fixture"}};
  let stateIndex=0;
  const wrappedReact={...React,useState(initial){const index=stateIndex++;return React.useState(index===0?payload:index===1?now:initial);}};
  const result = await build({entryPoints:[path.join(root,"app/components/KoreanPerpMonitor.tsx")],bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",external:["react","react/jsx-runtime","next/link"],logLevel:"silent",plugins:[{name:"benchmark-sources",setup(b){
    b.onLoad({filter:/app\/.*\.(tsx?|css|json)$/},async args=>{
      if(args.path.endsWith(".css"))return{contents:"export default new Proxy({}, {get:(_,key)=>String(key)});",loader:"js"};
      const relative=path.relative(root,args.path);
      const contents=version==="working"?await readFile(args.path,"utf8"):execFileSync("git",["show",`${version}:${relative}`],{cwd:root,encoding:"utf8"});
      return{contents,loader:args.path.endsWith(".tsx")?"tsx":args.path.endsWith(".json")?"json":"ts"};
    });
  }}]});
  let formatters=0;
  const Original=Intl.DateTimeFormat;
  Intl.DateTimeFormat=new Proxy(Original,{construct(target,args){formatters++;return Reflect.construct(target,args);}});
  const OriginalNumber=Intl.NumberFormat, originalLocale=Number.prototype.toLocaleString;
  Intl.NumberFormat=new Proxy(OriginalNumber,{construct(target,args){formatters++;return Reflect.construct(target,args);}});
  Number.prototype.toLocaleString=function(...args){formatters++;return originalLocale.apply(this,args);};
  const module={exports:{}};
  const customRequire=(id)=>id==="react"?wrappedReact:id==="next/link"?({children,...props})=>React.createElement("a",props,children):require(id);
  new Function("require","module","exports",result.outputFiles[0].text)(customRequire,module,module.exports);
  const render=()=>{stateIndex=0;return renderToString(React.createElement(module.exports.default));};
  let html=render();
  for(const text of ["Benchmark stock 23","TWTSMUSDT","WALSINUSDT","Implied KRW price vs previous close","CURRENT PERP"]) if(!html.includes(text))throw new Error(`Fixture did not render ${text}`);
  for(let i=0;i<4;i++)render();
  global.gc();
  formatters=0;
  const base=process.memoryUsage();
  let peakRss=base.rss,peakHeap=base.heapUsed;
  const cpu=process.cpuUsage(),started=performance.now();
  for(let i=0;i<120;i++){html=render();const usage=process.memoryUsage();peakRss=Math.max(peakRss,usage.rss);peakHeap=Math.max(peakHeap,usage.heapUsed);}
  const wallMs=performance.now()-started,used=process.cpuUsage(cpu);
  global.gc();
  const after=process.memoryUsage(),mib=1024*1024;
  console.log(JSON.stringify({version,cpuMs:(used.user+used.system)/1000,wallMs,peakRssMiB:peakRss/mib,rssGrowthMiB:(peakRss-base.rss)/mib,peakHeapMiB:peakHeap/mib,heapAfterGcMiB:after.heapUsed/mib,formatters,htmlBytes:Buffer.byteLength(html)}));
}
