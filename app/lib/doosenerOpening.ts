import { dayKey, shiftDay, tradingDay, usOpen, usClose, trainingRows, smicGroups } from "./smicOpening";
import type { SmicBar, SmicGroup, SmicRow } from "./smicOpening";

export type DoosenerRow=SmicRow & { ewyReturn:number };
export type DoosenerModel={n:number;start:string;end:string;intercept:number;smhBeta:number;ewyBeta:number;r2:number;minSmh:number;maxSmh:number;minEwy:number;maxEwy:number};
export type JointGroup=SmicGroup & {smhIndex:number;ewyIndex:number;smhLabel:string;ewyLabel:string};
const KR_HOLIDAYS:Record<string,string[]>={
  "2026":["01-01","02-16","02-17","02-18","03-02","05-01","05-05","05-25","06-03","07-17","08-17","09-24","09-25","10-05","10-09","12-25","12-31"],
  "2027":["01-01","02-08","02-09","03-01","05-03","05-05","05-13","07-19","08-16","09-14","09-15","09-16","10-04","10-11","12-27","12-31"],
};
// First trading day and college entrance examination sessions open one hour later.
const LATE_OPENS=new Set(["2026-01-02","2026-11-19","2027-01-04","2027-11-18"]);
export const krOpen=(date:string)=>Date.parse(`${date}T${LATE_OPENS.has(date)?"10":"09"}:00:00+09:00`);
export const krClose=(date:string)=>Date.parse(`${date}T${date==="2026-11-19"||date==="2027-11-18"?"16":"15"}:30:00+09:00`);
export function krTradingDay(date:string):boolean|null {
  const holidays=KR_HOLIDAYS[date.slice(0,4)];if(!holidays)return null;
  const weekday=new Date(`${date}T12:00:00Z`).getUTCDay();return weekday!==0&&weekday!==6&&!holidays.includes(date.slice(5));
}
function previous(date:string,market:"KR"|"US") {
  for(let i=1;i<20;i++){const d=shiftDay(date,-i),ok=market==="KR"?krTradingDay(d):tradingDay(d,"US");if(ok===null)return null;if(ok)return d;}return null;
}
export type DoosenerWindow={date:string;openAt:number;previousKrDate:string;signalDate:string|null;anchorDate:string|null;usDates:string[];error:string|null};
export function nextDoosenerWindow(now:number):DoosenerWindow|null {
  const today=dayKey(now,"Asia/Seoul");
  for(let i=0;i<20;i++){
    const date=shiftDay(today,i),valid=krTradingDay(date);if(valid===null)return null;if(!valid||krOpen(date)<=now)continue;
    const prev=previous(date,"KR");if(!prev)return null;const dates:string[]=[];
    for(let u=prev;u<=date;u=shiftDay(u,1)){const ok=tradingDay(u,"US");if(ok===null)return null;if(ok&&usOpen(u)>krClose(prev)&&usClose(u)<krOpen(date))dates.push(u);}
    return {date,openAt:krOpen(date),previousKrDate:prev,usDates:dates,signalDate:dates.length===1?dates[0]:null,anchorDate:dates.length===1?previous(dates[0],"US"):null,error:dates.length===0?"No new U.S. session before this KRX opening.":dates.length>1?"Multiple U.S. sessions during the Korean holiday: single-session model suspended.":null};
  }return null;
}
export function alignedDoosenerRows(kr:SmicBar[],smh:SmicBar[],ewy:SmicBar[],now:number):DoosenerRow[]{
  const k=[...kr].sort((a,b)=>a.date.localeCompare(b.date)),u=[...smh].sort((a,b)=>a.date.localeCompare(b.date)),e=new Map(ewy.map(b=>[b.date,b]));
  const timed=u.map((b,j)=>({b,j,openAt:usOpen(b.date),closeAt:usClose(b.date)})),rows:DoosenerRow[]=[];
  for(let i=1;i<k.length;i++){
    const current=k[i],prev=k[i-1];if(!prev.complete||krOpen(current.date)>now||!(current.open>0&&prev.close>0))continue;
    const start=krClose(prev.date),end=krOpen(current.date),matches=timed.filter(t=>t.b.complete&&t.openAt>start&&t.closeAt<end);
    if(matches.length!==1||matches[0].j===0)continue;
    const {b,j}=matches[0],before=u[j-1],ew=e.get(b.date);if(!before.complete||!ew?.complete||!(ew.open>0&&ew.close>0&&before.close>0&&b.close>0))continue;
    if(tradingDay(b.date,"US")!==null&&previous(b.date,"US")!==before.date)continue;
    if(krTradingDay(current.date)!==null&&previous(current.date,"KR")!==prev.date)continue;
    rows.push({date:current.date,usDate:b.date,previousHkDate:prev.date,smhReturn:100*(b.close/before.close-1),ewyReturn:100*(ew.close/ew.open-1),gap:100*(current.open/prev.close-1),open:current.open,previousClose:prev.close});
  }return rows;
}
export const doosenerTraining=(rows:DoosenerRow[],target:string)=>trainingRows(rows,target).filter(r=>Number.isFinite((r as DoosenerRow).ewyReturn)) as DoosenerRow[];
export function fitDoosener(rows:DoosenerRow[]):DoosenerModel|null{
  const n=rows.length;if(n<60)return null;
  const avg=(f:(r:DoosenerRow)=>number)=>rows.reduce((s,r)=>s+f(r),0)/n;
  const sx=avg(r=>r.smhReturn),ex=avg(r=>r.ewyReturn),y=avg(r=>r.gap);
  let ss=0,ee=0,se=0,sy=0,ey=0;
  for(const r of rows){const a=r.smhReturn-sx,b=r.ewyReturn-ex,c=r.gap-y;ss+=a*a;ee+=b*b;se+=a*b;sy+=a*c;ey+=b*c;}
  const determinant=ss*ee-se*se;if(determinant<=1e-10*Math.max(1,ss*ee))return null;
  const smhBeta=(sy*ee-ey*se)/determinant,ewyBeta=(ey*ss-sy*se)/determinant,intercept=y-smhBeta*sx-ewyBeta*ex;
  const sse=rows.reduce((s,r)=>s+(r.gap-intercept-smhBeta*r.smhReturn-ewyBeta*r.ewyReturn)**2,0),sst=rows.reduce((s,r)=>s+(r.gap-y)**2,0);
  return {n,start:rows[0].date,end:rows[n-1].date,intercept,smhBeta,ewyBeta,r2:sst>0?1-sse/sst:0,minSmh:Math.min(...rows.map(r=>r.smhReturn)),maxSmh:Math.max(...rows.map(r=>r.smhReturn)),minEwy:Math.min(...rows.map(r=>r.ewyReturn)),maxEwy:Math.max(...rows.map(r=>r.ewyReturn))};
}
export const JOINT_LABELS=["< −1%","−1% to +1%","≥ +1%"];
export const jointIndex=(x:number)=>x< -1?0:x>=1?2:1;
export function doosenerJointGroups(rows:DoosenerRow[]):JointGroup[]{
  return JOINT_LABELS.flatMap((smhLabel,smhIndex)=>JOINT_LABELS.map((ewyLabel,ewyIndex)=>{
    const selected=rows.filter(r=>jointIndex(r.smhReturn)===smhIndex&&jointIndex(r.ewyReturn)===ewyIndex);
    const summary=smicGroups(selected.map(r=>({...r,smhReturn:0})))[4];
    return {...summary,index:smhIndex*3+ewyIndex,label:`SMH ${smhLabel} · EWY ${ewyLabel}`,smhIndex,ewyIndex,smhLabel,ewyLabel};
  }));
}
export function doosenerEstimate(model:DoosenerModel|null,groups:JointGroup[],smh:number|null,ewy:number|null){
  if(!model||smh===null||ewy===null||!Number.isFinite(smh)||!Number.isFinite(ewy))return null;
  return {gap:model.intercept+model.smhBeta*smh+model.ewyBeta*ewy,group:groups[jointIndex(smh)*3+jointIndex(ewy)],extrapolated:smh<model.minSmh||smh>model.maxSmh||ewy<model.minEwy||ewy>model.maxEwy};
}
export function doosenerStudy(rows:DoosenerRow[],target:string){
  const training=doosenerTraining(rows,target),model=fitDoosener(training);
  const predictions=training.flatMap(r=>{const m=fitDoosener(doosenerTraining(rows,r.date));return m?[{date:r.date,actual:r.gap,predicted:m.intercept+m.smhBeta*r.smhReturn+m.ewyBeta*r.ewyReturn}]:[];});
  const n=predictions.length,nz=predictions.filter(r=>r.actual!==0),hits=nz.filter(r=>Math.sign(r.actual)===Math.sign(r.predicted)).length;
  return {model,groups:doosenerJointGroups(training),smhGroups:smicGroups(training),ewyGroups:smicGroups(training.map(r=>({...r,smhReturn:r.ewyReturn}))),backtest:{n,nonflat:nz.length,hits,mae:n?predictions.reduce((s,r)=>s+Math.abs(r.actual-r.predicted),0)/n:null,accuracy:nz.length?100*hits/nz.length:null,recent:predictions.slice(-10).reverse()}};
}
