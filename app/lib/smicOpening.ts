// Percentages are percentage-point numbers: 1 means +1%, not 0.01.
export type SmicRow = { date: string; usDate: string; previousHkDate: string; smhReturn: number; gap: number; open: number; previousClose: number };
export type SmicBar = { date: string; open: number; close: number; complete: boolean };
export type SmicModel = { n: number; start: string; end: string; intercept: number; beta: number; r2: number; minSignal: number; maxSignal: number };
export type SmicGroup = { index: number; label: string; n: number; mean: number | null; median: number | null; q10: number | null; q90: number | null; up: number; down: number; flat: number; upPct: number | null; downPct: number | null; flatPct: number | null; upInterval: [number, number] | null; downInterval: [number, number] | null };
const DAY = 86_400_000;
const HK_HOLIDAYS: Record<string, string[]> = {
  "2026": ["01-01","02-17","02-18","02-19","04-03","04-06","04-07","05-01","05-25","06-19","07-01","10-01","10-19","12-25"],
  "2027": ["01-01","02-08","02-09","03-26","03-29","04-05","05-13","06-09","07-01","09-16","10-01","10-08","12-27"],
};
const US_HOLIDAYS: Record<string, string[]> = {
  "2026": ["01-01","01-19","02-16","04-03","05-25","06-19","07-03","09-07","11-26","12-25"],
  "2027": ["01-01","01-18","02-15","03-26","05-31","06-18","07-05","09-06","11-25","12-24"],
};
const HK_HALF_DAYS = new Set(["2026-02-16","2026-12-24","2026-12-31","2027-02-05","2027-12-24","2027-12-31"]);
const US_HALF_DAYS = new Set(["2026-11-27","2026-12-24","2027-11-26"]);
export const SMIC_GROUP_LABELS = ["< −3%","−3% to −2%","−2% to −1%","−1% to 0%","0% to +1%","+1% to +2%","+2% to +3%","≥ +3%"];
export const SMIC_GROUP_EXAMPLES = [-3.5,-2.5,-1.5,-.5,.5,1.5,2.5,3.5];
export function dayKey(timestamp: number, zone = "Asia/Hong_Kong") {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
  return `${p.find(v=>v.type==="year")!.value}-${p.find(v=>v.type==="month")!.value}-${p.find(v=>v.type==="day")!.value}`;
}
export const shiftDay = (date: string, count: number) => new Date(Date.parse(`${date}T12:00:00Z`) + count * DAY).toISOString().slice(0,10);
export function zonedTime(date: string, hour: number, minute: number, zone: string) {
  const target = Date.parse(`${date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);
  let answer = target;
  for (let i=0;i<3;i++) {
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(answer);
    const get=(type:string)=>p.find(x=>x.type===type)!.value;
    answer += target-Date.parse(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`);
  }
  return answer;
}
export const hkOpen = (date:string) => Date.parse(`${date}T09:30:00+08:00`);
export const hkClose = (date:string) => Date.parse(`${date}T${HK_HALF_DAYS.has(date)?"12":"16"}:10:00+08:00`);
export const usOpen = (date:string) => zonedTime(date,9,30,"America/New_York");
export const usClose = (date:string) => zonedTime(date,US_HALF_DAYS.has(date)?13:16,0,"America/New_York");
export function tradingDay(date: string, market: "HK"|"US"): boolean | null {
  const holidays=(market==="HK"?HK_HOLIDAYS:US_HOLIDAYS)[date.slice(0,4)];
  if (!holidays) return null;
  const weekday=new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday!==0 && weekday!==6 && !holidays.includes(date.slice(5));
}
function previousDay(date:string,market:"HK"|"US") {
  for(let i=1;i<15;i++) {const d=shiftDay(date,-i);const valid=tradingDay(d,market);if(valid===null)return null;if(valid)return d;}
  return null;
}
export type SmicWindow = { date:string; openAt:number; previousHkDate:string; previousHkCloseAt:number; usDates:string[]; signalDate:string|null; anchorDate:string|null; error:string|null };
export function nextSmicWindow(now:number):SmicWindow|null {
  const today=dayKey(now);
  for(let i=0;i<15;i++) {
    const date=shiftDay(today,i);const valid=tradingDay(date,"HK");
    if(valid===null)return null;
    if(!valid || hkOpen(date)<=now)continue;
    const prev=previousDay(date,"HK");if(!prev)return null;
    const dates:string[]=[];
    for(let u=prev;u<=date;u=shiftDay(u,1)) {
      const ok=tradingDay(u,"US");if(ok===null)return null;
      if(ok && usOpen(u)>hkClose(prev) && usClose(u)<hkOpen(date))dates.push(u);
    }
    return {date,openAt:hkOpen(date),previousHkDate:prev,previousHkCloseAt:hkClose(prev),usDates:dates,signalDate:dates.length===1?dates[0]:null,anchorDate:dates.length===1?previousDay(dates[0],"US"):null,error:dates.length===0?"No new U.S. session in this HK overnight window.":dates.length>1?"Multiple U.S. sessions during the HK holiday: the single-session model is not applied.":null};
  }
  return null;
}
export function alignedSmicRows(hk:SmicBar[],us:SmicBar[],now:number):SmicRow[] {
  const h=[...hk].sort((a,b)=>a.date.localeCompare(b.date));const u=[...us].sort((a,b)=>a.date.localeCompare(b.date));const rows:SmicRow[]=[];
  for(let i=1;i<h.length;i++) {
    const current=h[i],prev=h[i-1];if(!prev.complete || hkOpen(current.date)>now || !(current.open>0 && prev.close>0))continue;
    const matches=u.map((b,j)=>({b,j})).filter(({b})=>b.complete && usOpen(b.date)>hkClose(prev.date) && usClose(b.date)<hkOpen(current.date));
    if(matches.length!==1 || matches[0].j===0)continue;
    const {b,j}=matches[0];const previousUs=u[j-1];if(!(previousUs.complete && b.close>0 && previousUs.close>0))continue;
    // A missing daily candle must not silently become a multi-day return.
    if(tradingDay(b.date,"US")!==null && previousDay(b.date,"US")!==previousUs.date)continue;
    if(tradingDay(current.date,"HK")!==null && previousDay(current.date,"HK")!==prev.date)continue;
    rows.push({date:current.date,usDate:b.date,previousHkDate:prev.date,smhReturn:100*(b.close/previousUs.close-1),gap:100*(current.open/prev.close-1),open:current.open,previousClose:prev.close});
  }
  return rows;
}
export function trainingRows(rows:SmicRow[],target:string,years=1) {
  const start=new Date(`${target}T12:00:00Z`);start.setUTCFullYear(start.getUTCFullYear()-years);const key=start.toISOString().slice(0,10);
  return rows.filter(r=>r.date>=key && r.date<target && Number.isFinite(r.smhReturn) && Number.isFinite(r.gap)).sort((a,b)=>a.date.localeCompare(b.date));
}
export function fitSmic(rows:SmicRow[]):SmicModel|null {
  if(rows.length<60)return null;
  const n=rows.length,mx=rows.reduce((s,r)=>s+r.smhReturn,0)/n,my=rows.reduce((s,r)=>s+r.gap,0)/n;
  const xx=rows.reduce((s,r)=>s+(r.smhReturn-mx)**2,0);if(xx<1e-10)return null;
  const beta=rows.reduce((s,r)=>s+(r.smhReturn-mx)*(r.gap-my),0)/xx,intercept=my-beta*mx;
  const sse=rows.reduce((s,r)=>s+(r.gap-intercept-beta*r.smhReturn)**2,0),sst=rows.reduce((s,r)=>s+(r.gap-my)**2,0);
  return {n,start:rows[0].date,end:rows[n-1].date,intercept,beta,r2:sst>0?1-sse/sst:0,minSignal:Math.min(...rows.map(r=>r.smhReturn)),maxSignal:Math.max(...rows.map(r=>r.smhReturn))};
}
export const smicGroupIndex = (x:number) => !Number.isFinite(x)?-1:x< -3?0:x>=3?7:Math.floor(x)+4;
function quantile(sorted:number[],q:number) {if(!sorted.length)return null;const p=(sorted.length-1)*q,a=Math.floor(p);return sorted[a]+(sorted[Math.min(a+1,sorted.length-1)]-sorted[a])*(p-a);}
function wilson(k:number,n:number):[number,number]|null {
  if(!n)return null;const z=1.95996398454,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
  return [(c-h)*100,(c+h)*100];
}
export function smicGroups(rows:SmicRow[]):SmicGroup[] {
  return SMIC_GROUP_LABELS.map((label,index)=>{
    const ys=rows.filter(r=>smicGroupIndex(r.smhReturn)===index).map(r=>r.gap).sort((a,b)=>a-b),n=ys.length;
    const up=ys.filter(y=>y>0).length,down=ys.filter(y=>y<0).length,flat=n-up-down;
    return {label,index,n,mean:n?ys.reduce((a,b)=>a+b,0)/n:null,median:quantile(ys,.5),q10:quantile(ys,.1),q90:quantile(ys,.9),up,down,flat,upPct:n?100*up/n:null,downPct:n?100*down/n:null,flatPct:n?100*flat/n:null,upInterval:wilson(up,n),downInterval:wilson(down,n)};
  });
}
export function smicEstimate(model:SmicModel|null,groups:SmicGroup[],signal:number|null) {
  if(!model || signal===null || !Number.isFinite(signal))return null;
  return {gap:model.intercept+model.beta*signal,group:groups[smicGroupIndex(signal)],extrapolated:signal<model.minSignal || signal>model.maxSignal};
}
export function smicBacktest(rows:SmicRow[],target:string) {
  const recent=trainingRows(rows,target);const predictions=recent.flatMap(r=>{
    const model=fitSmic(trainingRows(rows,r.date));return model?[{date:r.date,signal:r.smhReturn,actual:r.gap,predicted:model.intercept+model.beta*r.smhReturn}]:[];
  });
  const n=predictions.length,nonflat=predictions.filter(r=>r.actual!==0),hits=nonflat.filter(r=>Math.sign(r.actual)===Math.sign(r.predicted)).length;
  return {n,nonflat:nonflat.length,hits,mae:n?predictions.reduce((s,r)=>s+Math.abs(r.actual-r.predicted),0)/n:null,rmse:n?Math.sqrt(predictions.reduce((s,r)=>s+(r.actual-r.predicted)**2,0)/n):null,accuracy:nonflat.length?100*hits/nonflat.length:null,recent:predictions.slice(-10).reverse()};
}
