import seed from "../data/doosenerOpeningStudy.json";
import { dayKey, usOpen, usClose } from "./smicOpening";
import type { SmicBar } from "./smicOpening";
import { alignedDoosenerRows, doosenerEstimate, doosenerStudy, krClose, nextDoosenerWindow } from "./doosenerOpening";
import type { DoosenerRow, DoosenerWindow } from "./doosenerOpening";
import type { SmicLiveQuote } from "./smicOpeningMarket";
import { posleyAdrSnapshot } from "./posleyAdr";

type QuoteRecord={symbol?:string;bid?:number|null;ask?:number|null;marketTimestamp?:number|null};
type State=ReturnType<typeof initialState>;
type Root=typeof globalThis & {__FUTU_PUSH_SNAPSHOT__?:{receivedAt:number;payload:{quotes?:QuoteRecord[]}};__DOOSENER_OPENING_MARKET__?:State};
function initialState(){return {rows:seed.rows as DoosenerRow[],bars:seed.bars as Record<string,SmicBar[]>,asOf:seed.asOf,fetchedAt:0,error:"",retryAt:0,pending:null as Promise<void>|null,sessionPending:null as Promise<void>|null,sessionRetryAt:0,sessionError:"",version:0,modelCache:null as {key:string;value:ReturnType<typeof doosenerStudy>}|null};}
const shared=()=>{const root=globalThis as Root;return root.__DOOSENER_OPENING_MARKET__??=initialState();};
type YahooResult={meta?:{symbol?:string};timestamp?:number[];indicators?:{quote?:Array<{open?:Array<number|null>;close?:Array<number|null>;volume?:Array<number|null>}>}};
export function parseDoosenerDaily(payload:unknown,symbol:string,now:number,minRows=200):SmicBar[]{
  const r=(payload as {chart?:{result?:YahooResult[]}})?.chart?.result?.[0];
  if(r?.meta?.symbol!==symbol||!r.timestamp?.length)throw new Error("Invalid daily history.");
  const q=r.indicators?.quote?.[0],zone=symbol==="034020.KS"?"Asia/Seoul":"America/New_York";
  const bars=r.timestamp.flatMap((t,i)=>{
    const open=q?.open?.[i],close=q?.close?.[i],volume=q?.volume?.[i];
    if(typeof open!=="number"||typeof close!=="number"||!Number.isFinite(open)||!Number.isFinite(close)||open<=0||close<=0||!(Number(volume)>0))return [];
    const date=dayKey(t*1000,zone),end=symbol==="034020.KS"?krClose(date):usClose(date);
    return [{date,open,close,complete:now>=end+10*60_000}];
  });
  if(bars.length<minRows)throw new Error("Incomplete daily history.");return bars;
}
async function daily(symbol:string,now:number,range="5y"){
  let error:unknown;
  for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]){
    try{const r=await fetch(`https://${host}/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=div%2Csplits`,{headers:{"User-Agent":"Mozilla/5.0",Accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(6_000)});if(!r.ok)throw new Error(`History HTTP ${r.status}`);return parseDoosenerDaily(await r.json(),symbol,now,range==="5y"?200:1);}catch(e){error=e;}
  }throw error;
}
function refreshHistory(now:number){
  const s=shared();if(s.pending||now<s.retryAt||now-s.fetchedAt<30*60_000)return;
  s.retryAt=now+60_000;
  s.pending=(async()=>{
    const [kr,smh,ewy]=await Promise.all([daily("034020.KS",now),daily("SMH",now),daily("EWY",now)]);
    const rows=alignedDoosenerRows(kr,smh,ewy,now);if(rows.length<200||(rows.at(-1)?.date??"")<s.asOf)throw new Error("History older than research sample.");
    const merged=new Map(s.rows.map(r=>[r.date,r]));rows.forEach(r=>merged.set(r.date,r));s.rows=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));
    s.bars={"034020.KS":kr,SMH:smh,EWY:ewy};s.asOf=s.rows.at(-1)!.date;s.fetchedAt=Date.now();s.error="";s.version++;
  })().catch(()=>{s.error="History refresh unavailable; the dated research sample is retained.";s.retryAt=Date.now()+5*60_000;}).finally(()=>{s.pending=null;});
}
function refreshEwySession(now:number,window:DoosenerWindow|null){
  const s=shared(),date=window?.signalDate;if(!date||now<usOpen(date)||s.sessionPending||s.pending||now<s.sessionRetryAt)return;
  const bar=s.bars.EWY.find(b=>b.date===date);
  if(bar&&(now<usClose(date)||bar.complete))return;
  s.sessionRetryAt=now+15_000;
  s.sessionPending=daily("EWY",now,"5d").then(bars=>{
    const merged=new Map(s.bars.EWY.map(b=>[b.date,b]));bars.forEach(b=>merged.set(b.date,b));s.bars.EWY=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));s.sessionError="";
  }).catch(()=>{s.sessionError="EWY session open/close confirmation is temporarily unavailable.";s.sessionRetryAt=Date.now()+30_000;}).finally(()=>{s.sessionPending=null;});
}
export function selectOpeningEtf(records:QuoteRecord[],receivedAt:number,now:number,symbol:"SMH"|"EWY"):SmicLiveQuote|null{
  const r=records.find(q=>q.symbol===`US.${symbol}`);if(!r)return null;
  const bid=Number(r.bid),ask=Number(r.ask),t=Number(r.marketTimestamp);
  if(!(bid>0&&ask>=bid&&Number.isFinite(bid)&&Number.isFinite(ask)&&t>0&&t<=now+5_000))return null;
  const fresh=now-t<=30_000&&now-receivedAt<=30_000;
  return {price:(bid+ask)/2,bid,ask,timestamp:t,receivedAt,source:`Posley Futu · US.${symbol} ETF BBO midpoint`,fresh,error:fresh?null:`${symbol} retained quote: live updates are stale.`};
}
async function liveEtfs(now:number){
  const push=(globalThis as Root).__FUTU_PUSH_SNAPSHOT__,quotes=push?.payload.quotes??[];
  const select=(symbol:"SMH"|"EWY")=>push?selectOpeningEtf(quotes,push.receivedAt,now,symbol):null;
  let smh=select("SMH"),ewy=select("EWY");
  if(!smh||!ewy){
    try{const remote=await posleyAdrSnapshot(["SMH","EWY"]);for(const symbol of ["SMH","EWY"] as const){if(symbol==="SMH"?smh:ewy)continue;const book=remote.books.find(b=>b.symbol===symbol);if(!book)continue;const q=selectOpeningEtf([{symbol:`US.${symbol}`,bid:book.bid,ask:book.ask,marketTimestamp:book.timestamp}],remote.timestamp,now,symbol);if(symbol==="SMH")smh=q;else ewy=q;}}catch{/* Preserve the genuine office observations if remote access is unavailable. */}
  }
  const missing=(symbol:string):SmicLiveQuote=>({price:null,bid:null,ask:null,timestamp:null,receivedAt:null,source:`Posley Futu · US.${symbol} ETF`,fresh:false,error:`Waiting for the ${symbol} ETF feed.`});
  return {smh:smh??missing("SMH"),ewy:ewy??missing("EWY")};
}
export function ewySessionInput(window:DoosenerWindow|null,bars:SmicBar[],quote:SmicLiveQuote,now:number){
  const date=window?.signalDate??null,bar=bars.find(b=>b.date===date),open=bar?.open??null;
  if(!date)return {mode:"waiting",return:null,effectiveReturn:null,open:null,close:null,sessionDate:date,message:"Waiting for an eligible U.S. session."};
  if(now<usOpen(date))return {mode:"preopen_assumption",return:null,effectiveReturn:0,open:null,close:null,sessionDate:date,message:"Before U.S. open: EWY intraday input is assumed 0%, not an observed return."};
  if(!bar)return {mode:"waiting_open",return:null,effectiveReturn:null,open:null,close:null,sessionDate:date,message:"Waiting for the target session’s reported regular EWY opening price."};
  if(now>=usClose(date)){
    const value=bar.complete?100*(bar.close/bar.open-1):null;
    return {mode:value===null?"waiting_close":"regular_close",return:value,effectiveReturn:value,open,close:bar.complete?bar.close:null,sessionDate:date,message:value===null?"Waiting for confirmation of the EWY regular-session closing price.":"EWY regular open-to-close return is fixed; SMH continues to use its live quote."};
  }
  const value=quote.price!==null&&quote.timestamp!==null&&quote.timestamp>=usOpen(date)?100*(quote.price/bar.open-1):null;
  return {mode:"live_session",return:value,effectiveReturn:value,open,close:null,sessionDate:date,message:value===null?"Waiting for an EWY quote from the current U.S. regular session.":"Live EWY midpoint / this U.S. regular-session opening price − 1."};
}
export async function doosenerOpeningState(now=Date.now()){
  const s=shared();refreshHistory(now);const window=nextDoosenerWindow(now);refreshEwySession(now,window);
  const target=window?.date??dayKey(now,"Asia/Seoul"),key=`${target}:${s.version}`;
  if(s.modelCache?.key!==key)s.modelCache={key,value:doosenerStudy(s.rows,target)};
  const study=s.modelCache!.value,quotes=await liveEtfs(now),ewy=ewySessionInput(window,s.bars.EWY,quotes.ewy,now);
  const anchor=window?.anchorDate?s.bars.SMH.find(b=>b.date===window.anchorDate&&b.complete):null;
  const krAnchor=window?s.bars["034020.KS"].find(b=>b.date===window.previousKrDate&&b.complete):null;
  const quoteInWindow=Boolean(window?.anchorDate&&quotes.smh.timestamp!==null&&quotes.smh.timestamp>=usClose(window.anchorDate));
  const signal=anchor&&quoteInWindow&&quotes.smh.price!==null?100*(quotes.smh.price/anchor.close-1):null;
  const modelStale=Date.parse(`${target}T12:00:00Z`)-Date.parse(`${s.asOf}T12:00:00Z`)>10*86_400_000;
  const forecast=window&&!window.error&&!modelStale?doosenerEstimate(study.model,study.groups,signal,ewy.effectiveReturn):null;
  const fresh=quotes.smh.fresh&&(ewy.mode==="preopen_assumption"||ewy.mode==="regular_close"||(ewy.mode==="live_session"&&quotes.ewy.fresh));
  return {timestamp:now,target:window,phase:ewy.mode,quote:quotes.smh,ewyQuote:quotes.ewy,ewy,signal,fresh,forecast,smhAnchor:anchor?{date:anchor.date,price:anchor.close}:null,krAnchor:krAnchor?{date:krAnchor.date,price:krAnchor.close}:null,impliedOpen:forecast&&krAnchor?krAnchor.close*(1+forecast.gap/100):null,...study,lastOutcome:study.backtest.recent[0]??null,history:{asOf:s.asOf,fetchedAt:s.fetchedAt||null,refreshing:Boolean(s.pending),error:s.error,sessionError:s.sessionError,modelStale},error:!window?"Trading calendar coverage unavailable.":window.error??(modelStale?"Historical model is out of date.":!anchor?"Waiting for the required SMH regular close anchor.":!quoteInWindow?"Waiting for an SMH quote after the required close anchor.":ewy.effectiveReturn===null?ewy.message:null)};
}
export type DoosenerOpeningPayload=Awaited<ReturnType<typeof doosenerOpeningState>>;
