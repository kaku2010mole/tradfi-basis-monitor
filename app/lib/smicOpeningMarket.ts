import seed from "../data/smicOpeningStudy.json";
import { alignedSmicRows, dayKey, fitSmic, hkClose, nextSmicWindow, smicBacktest, smicEstimate, smicGroups, trainingRows, usClose, usOpen } from "./smicOpening";
import type { SmicBar, SmicRow } from "./smicOpening";
import { posleyAdrSnapshot } from "./posleyAdr";

type QuoteRecord = { symbol?:string; bid?:number|null; ask?:number|null; marketTimestamp?:number|null; source?:string };
type Root = typeof globalThis & {
  __FUTU_PUSH_SNAPSHOT__?: { receivedAt:number; payload:{ quotes?:QuoteRecord[] } };
  __SMIC_OPENING_MARKET__?: ReturnType<typeof initialState>;
};
function initialState() {
  return {rows:seed.rows as SmicRow[],bars:seed.bars as Record<string,SmicBar[]>,historyAsOf:seed.asOf,historyFetchedAt:0,historyError:"",retryAt:0,pending:null as Promise<void>|null,version:0,modelCache:null as {key:string;value:ReturnType<typeof studyView>}|null};
}
const shared=()=>{const root=globalThis as Root;return root.__SMIC_OPENING_MARKET__??=initialState();};
type YahooResult={meta?:{symbol?:string;exchangeTimezoneName?:string};timestamp?:number[];indicators?:{quote?:Array<{open?:Array<number|null>;close?:Array<number|null>;volume?:Array<number|null>}>}};
export function parseSmicDaily(payload:unknown,symbol:string,now:number):SmicBar[] {
  const r=(payload as {chart?:{result?:YahooResult[]}})?.chart?.result?.[0];
  if(r?.meta?.symbol!==symbol || !r.timestamp?.length)throw new Error(`Invalid daily history for ${symbol}.`);
  const q=r.indicators?.quote?.[0];const zone=symbol==="SMH"?"America/New_York":"Asia/Hong_Kong";
  const rows=r.timestamp.flatMap((t,i)=>{
    const open=q?.open?.[i],close=q?.close?.[i],volume=q?.volume?.[i];
    if(typeof open!=="number" || typeof close!=="number" || !Number.isFinite(open) || !Number.isFinite(close) || open<=0 || close<=0 || !(Number(volume)>0))return [];
    const date=dayKey(t*1000,zone),end=symbol==="SMH"?usClose(date):hkClose(date);
    return [{date,open,close,complete:now>=end+10*60_000}];
  });
  if(rows.length<200)throw new Error(`Incomplete daily history for ${symbol}.`);
  return rows;
}
async function daily(symbol:string,now:number) {
  let last:unknown;
  for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]) {
    try {
      const r=await fetch(`https://${host}/v8/finance/chart/${symbol}?range=5y&interval=1d&events=div%2Csplits`,{headers:{"User-Agent":"Mozilla/5.0",Accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(8_000)});
      if(!r.ok)throw new Error(`Daily history HTTP ${r.status}`);
      return parseSmicDaily(await r.json(),symbol,now);
    }catch(e){last=e;}
  }
  throw last;
}
function refreshHistory(now:number) {
  const s=shared();if(s.pending || now<s.retryAt || now-s.historyFetchedAt<30*60_000)return;
  s.retryAt=now+60_000;
  s.pending=(async()=>{
    const [hk,us]=await Promise.all([daily("0981.HK",now),daily("SMH",now)]);
    const observed=alignedSmicRows(hk,us,now);
    const latest=s.rows.at(-1)?.date??"";
    if(observed.length<200 || (observed.at(-1)?.date??"")<latest)throw new Error("Daily history is older than the retained research sample.");
    const merged=new Map(s.rows.map(r=>[r.date,r]));observed.forEach(r=>merged.set(r.date,r));
    s.rows=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));s.bars={"0981.HK":hk,SMH:us};
    s.historyAsOf=s.rows.at(-1)!.date;s.historyFetchedAt=Date.now();s.historyError="";s.version++;
  })().catch(()=>{s.historyError="History refresh unavailable; the dated research sample is retained.";s.retryAt=Date.now()+5*60_000;}).finally(()=>{s.pending=null;});
}
function studyView(rows:SmicRow[],target:string) {
  const training=trainingRows(rows,target);return {model:fitSmic(training),groups:smicGroups(training),backtest:smicBacktest(rows,target)};
}
export type SmicLiveQuote={price:number|null;bid:number|null;ask:number|null;timestamp:number|null;receivedAt:number|null;source:string;fresh:boolean;error:string|null};
export function selectSmhBook(records:QuoteRecord[],receivedAt:number,now:number):SmicLiveQuote|null {
  const r=records.find(q=>q.symbol==="US.SMH");if(!r)return null;
  const bid=Number(r.bid),ask=Number(r.ask),t=Number(r.marketTimestamp);
  if(!(bid>0 && ask>=bid && Number.isFinite(bid) && Number.isFinite(ask) && t>0 && t<=now+5_000))return null;
  return {price:(bid+ask)/2,bid,ask,timestamp:t,receivedAt,source:"Posley Futu · US.SMH ETF BBO midpoint",fresh:now-t<=30_000 && now-receivedAt<=30_000,error:now-t>30_000 || now-receivedAt>30_000?"Retained quote: live updates are stale.":null};
}
async function liveSmh(now:number):Promise<SmicLiveQuote> {
  const push=(globalThis as Root).__FUTU_PUSH_SNAPSHOT__;
  const office=push?selectSmhBook(push.payload.quotes??[],push.receivedAt,now):null;
  if(office)return office;
  try {
    const remote=await posleyAdrSnapshot(["SMH"]),b=remote.books.find(q=>q.symbol==="SMH");
    if(b) {const book=selectSmhBook([{symbol:"US.SMH",bid:b.bid,ask:b.ask,marketTimestamp:b.timestamp}],remote.timestamp,now);if(book)return {...book,source:`Posley ETF BBO · ${b.streamKey}`};}
    return {price:null,bid:null,ask:null,timestamp:null,receivedAt:null,source:"Posley Futu · US.SMH ETF",fresh:false,error:remote.error||"Waiting for the SMH ETF feed."};
  }catch {return {price:null,bid:null,ask:null,timestamp:null,receivedAt:null,source:"Posley Futu · US.SMH ETF",fresh:false,error:"SMH ETF live feed is unavailable."};}
}
export async function smicOpeningState(now=Date.now()) {
  const s=shared();refreshHistory(now);
  const window=nextSmicWindow(now),target=window?.date??dayKey(now),cacheKey=`${target}:${s.version}`;
  if(s.modelCache?.key!==cacheKey)s.modelCache={key:cacheKey,value:studyView(s.rows,target)};
  const study=s.modelCache!.value;
  const quote=await liveSmh(now);
  const anchor=window?.anchorDate?s.bars.SMH.find(b=>b.date===window.anchorDate && b.complete):undefined;
  const hkAnchor=window?s.bars["0981.HK"].find(b=>b.date===window.previousHkDate && b.complete):undefined;
  // Fix this denominator to the forecasted HK session, including US after-hours.
  // It must not reset at 16:00 ET while that HK opening is still in the future.
  const quoteInWindow=Boolean(window?.anchorDate && quote.timestamp!==null && quote.timestamp>=usClose(window.anchorDate));
  const signal=anchor && quote.price!==null && quoteInWindow?100*(quote.price/anchor.close-1):null;
  const age=Date.parse(`${target}T12:00:00Z`)-Date.parse(`${s.historyAsOf}T12:00:00Z`);
  const modelStale=age>10*86_400_000;
  const forecast=window && !window.error && !modelStale?smicEstimate(study.model,study.groups,signal):null;
  const phase=!window?"calendar_unavailable":window.error?"unsupported_window":window.signalDate && now<usOpen(window.signalDate)?"early_estimate":window.signalDate && now<usClose(window.signalDate)?"us_session_estimate":"after_us_close";
  const last=study.backtest.recent[0]??null;
  return {timestamp:now,target:window,phase,quote,signal,forecast,smhAnchor:anchor?{date:anchor.date,price:anchor.close}:null,hkAnchor:hkAnchor?{date:hkAnchor.date,price:hkAnchor.close}:null,impliedOpen:forecast && hkAnchor?hkAnchor.close*(1+forecast.gap/100):null,...study,history:{asOf:s.historyAsOf,fetchedAt:s.historyFetchedAt||null,refreshing:Boolean(s.pending),error:s.historyError,modelStale},lastOutcome:last,error:!window?"Verified trading calendar covers 2026–2027 only.":window.error??(modelStale?"Historical model is out of date.":!anchor?"Waiting for the required SMH regular-session close.":!quoteInWindow?"Waiting for an SMH quote after the required close anchor.":null)};
}
export type SmicOpeningPayload = Awaited<ReturnType<typeof smicOpeningState>>;
