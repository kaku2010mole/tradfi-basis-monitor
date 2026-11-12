'use strict';
const $=id=>document.getElementById(id),colors=['var(--lime)','var(--blue)','var(--orange)','var(--purple)'];
let state={},series={},days=7,position=null;
let stateAvailable=false,positionRequest=null;
let historyController=null,historyKey='';
const hiddenLines={};
try{const saved=JSON.parse(localStorage.getItem('jlp-chart-hidden-lines')||'{}');for(const [id,keys] of Object.entries(saved||{}))if(Array.isArray(keys))hiddenLines[id]=new Set(keys.filter(k=>typeof k==='string'));}catch{}
function saveHiddenLines(){try{localStorage.setItem('jlp-chart-hidden-lines',JSON.stringify(Object.fromEntries(Object.entries(hiddenLines).map(([id,keys])=>[id,[...keys]]))));}catch{}}
function lineLegend(id,sets,redraw){
 const legend=$(id).parentElement.querySelector('.legend');
 if(!legend||sets.length<2)return;
 const signature=sets.map(s=>s.key).join('|');
 if(legend.dataset.series!==signature){
  legend.dataset.series=signature;
  legend.innerHTML=sets.map(s=>`<button type="button" class="legend-toggle" data-series="${s.key}" aria-controls="${id}" style="--c:${s.color}"><span class="legend-check" aria-hidden="true"></span>${s.label}</button>`).join('');
 }
 const hidden=hiddenLines[id]||new Set();
 legend.querySelectorAll('button[data-series]').forEach(button=>{const visible=!hidden.has(button.dataset.series);button.setAttribute('aria-pressed',String(visible));button.title=(visible?'Hide ':'Show ')+button.textContent;button.querySelector('.legend-check').textContent=visible?'✓':'−';});
 legend.onclick=e=>{const button=e.target.closest('button[data-series]');if(!button||!legend.contains(button))return;const hidden=hiddenLines[id]||(hiddenLines[id]=new Set()),key=button.dataset.series;hidden.has(key)?hidden.delete(key):hidden.add(key);saveHiddenLines();redraw();};
}
const fmt=(v,n=2)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n}):'—';
const pct=(v,n=2)=>fmt(v,n)+(typeof v==='number'?'%':'');
const usd=(v,n=4)=>typeof v==='number'?'$'+fmt(v,n):'—';
const dt=t=>t?new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Hong_Kong',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'Time unknown';
const age=t=>t?Math.max(0,Math.floor((Date.now()-t)/1000)):Infinity;
const health=(d,seconds=45)=>!d?.fetchedAt?'Waiting for data':d.error?'Update failed · last record retained':age(d.fetchedAt)>seconds?'Stale data':`Updated ${age(d.fetchedAt)}s ago`;
function renderState(){
 const p=state.pool||{},l=state.loan||{},q=state.price||{},f=state.funding||{};
 $('market').textContent=usd(q.price,6);$('nav').textContent=usd(p.nav,6);
 $('marketmeta').textContent=`Price timestamp ${dt(q.sourceAt)} · slot ${q.slot||'—'}`;
 const valid=age(q.fetchedAt)<45&&age(q.sourceAt)<120&&age(p.fetchedAt)<45&&!p.error&&!q.error&&typeof q.premium==='number';
 const premium=typeof q.price==='number'&&p.nav?(q.price/p.nav-1)*100:null;
 $('premium').textContent=valid?`${premium>=0?'+':''}${fmt(premium,4)}% ${premium>=0?'Premium':'Discount'}`:'Waiting for fresh quotes';
 $('premium').className=valid?(premium>=0?'positive':'negative'):'error';
 $('pricestatus').textContent=`Market: ${health(q)} · NAV: ${health(p)}${!valid?' · Premium calculation paused':''}`;
 $('yield').textContent=pct(p.apy);$('apr').textContent=pct(p.apr);$('aum').textContent=p.aum?usd(p.aum/1e6,2)+'M':'—';
 $('yieldtime').textContent=`Official yield updated ${dt(p.yieldUpdatedAt)} · feed: ${health(p)}`;
 $('borrow').textContent=pct(l.apr);$('util').textContent=pct(l.utilization);$('utilbar').style.width=Math.min(100,l.utilization||0)+'%';
 $('available').textContent=typeof l.available==='number'?usd(l.available/1e6,2)+'M':'—';$('loantime').textContent=health(l);
 $('fundcards').innerHTML=['BTC','ETH','SOL'].map((coin,i)=>{const c=f.coins?.[coin]||{};return `<article class="card fundcard"><div class="fundtop"><span><span class="coin" style="background:${[colors[0],colors[1],colors[3]][i]}">${coin[0]}</span>${coin}</span><span class="tag">1H</span></div><div class="fundvalues"><strong class="${c.hourly<0?'negative':'positive'}">${pct(c.hourly,6)}</strong><span>Annualized ${pct(c.annual)}</span></div><div class="meta">${health(f)} · Current rate</div></article>`}).join('');
 const all=[p,l,q,f].every(d=>d.fetchedAt&&!d.error&&age(d.fetchedAt)<45)&&age(q.sourceAt)<120;
 $('health').textContent=all?'● Data feeds connected':'Some feeds pending / delayed';$('health').className=all?'':'error';
 $('clock').textContent=dt(Date.now())+' HKT';
 renderStrategy();
 updateExport();
 $('coverage').textContent=`Price / borrow records since ${dt(state.collectionStartedAt)} · 90-day fee yield and funding backfill`;
}

function nearestPoint(points,time){
 let low=0,high=points.length;
 while(low<high){
  const mid=(low+high)>>>1;
  if(points[mid][0]<time)low=mid+1;
  else high=mid;
 }
 const left=points[low-1],right=points[low];
 if(!left)return right;
 if(!right)return left;
 return time-left[0]<=right[0]-time?left:right;
}

function chart(id,sets,unit,zero=false,rangeDays=days){
 const el=$(id),start=Date.now()-rangeDays*86400000,end=Date.now();
 const allSets=sets;
 el.onpointerleave?.();
 el.onpointermove=el.onpointerleave=el.onclick=null;
 lineLegend(id,allSets,()=>chart(id,allSets,unit,zero,rangeDays));
 sets=sets.filter(s=>!hiddenLines[id]?.has(s.key));
 if(!sets.length){el.innerHTML='<div class="empty"><span>All lines hidden</span><span>Select a legend item below to show a line.</span></div>';el.onpointermove=null;el.onpointerleave=null;return;}
 sets=sets.map(s=>({...s,points:(s.points??series[s.key]??[]).filter(p=>Number.isFinite(p[1])&&p[0]>=start&&p[0]<=end)}));
 let ymin=Infinity,ymax=-Infinity;
 for(const s of sets)for(const [,value] of s.points){ymin=Math.min(ymin,value);ymax=Math.max(ymax,value);}
 if(ymin===Infinity){el.innerHTML='<div class="empty"><span>No records in this range</span><span>Waiting for collection / backfill</span></div>';return;}
 if(zero){ymin=Math.min(0,ymin);ymax=Math.max(0,ymax);}
 const pad=(ymax-ymin)*.12||Math.max(Math.abs(ymax)*.0001,.0001);ymin-=pad;ymax+=pad;
 const W=640,H=230,L=62,R=12,T=15,B=30,x=t=>L+(t-start)/(end-start)*(W-L-R),y=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);
 const nf=v=>unit==='USD'?'$'+fmt(v,4):fmt(v,Math.abs(v)<.01?5:2)+'%';
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${el.parentElement.querySelector('h3').textContent} history chart">`;
 for(let i=0;i<5;i++){const yy=T+i*(H-T-B)/4,v=ymax-i*(ymax-ymin)/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="var(--chart-grid)" stroke-dasharray="3 5"/><text x="${L-8}" y="${yy+4}" fill="var(--muted)" text-anchor="end" font-size="12">${nf(v)}</text>`;}
 if(zero)svg+=`<line x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--chart-zero)"/>`;
 for(let i=0;i<4;i++){const t=start+i*(end-start)/3,xx=x(t);const label=new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Hong_Kong',...(rangeDays<=1?{hour:'2-digit',minute:'2-digit'}:{month:'2-digit',day:'2-digit'}),hour12:false});svg+=`<text x="${xx}" y="${H-4}" fill="var(--muted)" font-size="12" text-anchor="${i===0?'start':i===3?'end':'middle'}">${label}</text>`;}
 for(const s of sets){
  let path='',previousTime=null;
  const gap=s.daily?36*3600000:s.settled?5400000:Math.max(150000,rangeDays*86400000/1200*2);
  for(const [time,value] of s.points){
   path+=(previousTime!==null&&time-previousTime<=gap?'L':'M')+x(time).toFixed(2)+','+y(value).toFixed(2);
   previousTime=time;
  }
  svg+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
  if(s.points.length<=2)for(const [time,value] of s.points)svg+=`<circle cx="${x(time)}" cy="${y(value)}" r="3" fill="${s.color}"/>`;
 }
 svg+=`<line class="cross" stroke="var(--chart-crosshair)" y1="${T}" y2="${H-B}" visibility="hidden"/>`;
 svg+=sets.map(s=>`<circle class="chart-point" r="3" fill="${s.color}" visibility="hidden"/>`).join('');
 el.innerHTML=svg+'</svg><div class="tip" hidden></div>';
 const plot=el.querySelector('svg'),tip=el.querySelector('.tip'),cross=el.querySelector('.cross');
 const markers=el.querySelectorAll('.chart-point');
 let frame=0,pointer,tooltipKey='';
 const hide=()=>{
  tip.hidden=true;
  cross.setAttribute('visibility','hidden');
  for(const marker of markers)marker.setAttribute('visibility','hidden');
 };
 const inspect=({clientX,clientY})=>{
  const matrix=plot.getScreenCTM();
  if(!matrix)return hide();
  // The SVG can be letterboxed inside the chart div or scaled inside its iframe.
  const point=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());
  if(!Number.isFinite(point.x)||point.x<L||point.x>W-R||point.y<T||point.y>H-B)return hide();
  const time=start+(point.x-L)/(W-L-R)*(end-start);
  const items=[];
  for(const [index,s] of sets.entries()){
   const nearest=nearestPoint(s.points,time);
   const tolerance=s.daily?86400000:s.settled?3600000:Math.max(90000,rangeDays*86400000/1200);
   const marker=markers[index];
   if(!nearest||Math.abs(nearest[0]-time)>tolerance){marker.setAttribute('visibility','hidden');continue;}
   marker.setAttribute('cx',x(nearest[0]));
   marker.setAttribute('cy',y(nearest[1]));
   marker.setAttribute('visibility','visible');
   items.push({series:s,point:nearest});
  }
  if(!items.length)return hide();
  const selected=items.reduce((a,b)=>Math.abs(a.point[0]-time)<=Math.abs(b.point[0]-time)?a:b).point;
  const key=items.map(({series:s,point:p})=>`${s.key}:${p[0]}`).join('|');
  if(key!==tooltipKey){
   tooltipKey=key;
   tip.innerHTML=items.map(({series:s,point:p})=>`<div style="color:${s.color}">${s.label} · ${nf(p[1])}<br><span style="color:#94a6b5">${dt(p[0])}</span></div>`).join('');
  }
  tip.hidden=false;
  const box=el.getBoundingClientRect();
  const localX=(clientX-box.left)*el.clientWidth/box.width;
  tip.style.left=Math.max(0,Math.min(localX+10,el.clientWidth-tip.offsetWidth))+'px';
  tip.style.top='8px';
  cross.setAttribute('x1',x(selected[0]));
  cross.setAttribute('x2',x(selected[0]));
  cross.setAttribute('visibility','visible');
 };
 el.onpointermove=e=>{
  pointer=e;
  if(!frame)frame=requestAnimationFrame(()=>{frame=0;inspect(pointer);});
 };
 el.onpointerleave=()=>{cancelAnimationFrame(frame);frame=0;hide();};
 el.onclick=inspect;
}
function renderCharts(){
 renderCarryChart();
 chart('hedgechart',['BTC','ETH','SOL'].map((c,i)=>({key:'hedge_ratio_'+c,label:c,color:[colors[0],colors[1],colors[3]][i]})),'%');
 chart('pricechart',[{key:'market_price',label:'Market price',color:colors[0]},{key:'nav',label:'NAV',color:colors[1]}],'USD');
 chart('premiumchart',[{key:'premium',label:'Premium / discount',color:colors[0]}],'%',true);
 chart('yieldchart',[{key:'jlp_apr_archive',label:'Historical 7-day fee APR',color:colors[0],daily:true},{key:'jlp_apr',label:'Official APR',color:colors[1]},{key:'borrow_apr',label:'Borrow APR',color:colors[2]}],'%');
 renderFundingChart();
}
function renderFundingChart(){
 const multiplier=Number($('fundunit').value);
 chart('fundchart',['BTC','ETH','SOL'].map((coin,i)=>{
  const key='funding_'+coin;
  return {key,label:coin,color:[colors[0],colors[1],colors[3]][i],settled:true,
   points:(series[key]||[]).map(([time,value])=>[time,value*multiplier])};
 }),'%',true);
}

const manualSettings={leverage:$('leverage').value,capital:$('equity').value};
const usingPosition=()=>position!==null&&$('useActualPosition').checked;

function settings(){
 const hedgeLeverage=Number($('hedgeleverage').value);
 let leverage=Number($('leverage').value),capital=Number($('equity').value);
 if(usingPosition()){
  const s=state.strategy||{};
  const notional=position.jlpUnits*s.market;
  const equity=notional-position.borrowedUsdc;
  if(!(equity>0)||!Number.isFinite(s.marginNotionalPer1x)||s.marginNotionalPer1x<0)return null;
  leverage=notional/equity;
  capital=equity+notional*s.marginNotionalPer1x/hedgeLeverage;
 }
 if(!Number.isFinite(leverage)||leverage<1||leverage>10||!Number.isFinite(hedgeLeverage)||hedgeLeverage<1||hedgeLeverage>40||!Number.isFinite(capital)||capital<1||capital>1e9)return null;
 return {leverage,hedgeLeverage,capital};
}
function updateExport(){
 const {leverage,hedgeLeverage}=settings()||{leverage:2,hedgeLeverage:10};
 $('export').href='/api/jlp/export.csv?'+new URLSearchParams({days,leverage,hedgeLeverage});
}
function renderStrategy(){
 const p=state.pool||{},s=state.strategy||{},x=settings();
 if(usingPosition()){
  $('leverage').value=x?x.leverage.toFixed(3):'';
  $('equity').value=x?x.capital.toFixed(2):'';
 }
 const sources=['pool','loan','price','funding'];
 const estimate=x&&age(s.fetchedAt)<15*60&&s.market>0&&s.nav>0&&
  [s.market,s.nav,s.marginNotionalPer1x,s.feeAprPer1x,s.fundingAprPer1x,s.borrowApr,s.maxLtv].every(Number.isFinite)&&
  sources.every(k=>Number.isFinite(s.inputTimes?.[k])&&s.inputTimes[k]>0);
 const live=estimate&&stateAvailable&&!s.error&&age(s.fetchedAt)<45&&
  sources.every(k=>!state[k]?.error&&age(s.inputTimes[k])<45)&&age(state.price?.sourceAt)<120;
 const factor=x&&typeof s.marginNotionalPer1x==='number'?1+x.leverage*s.marginNotionalPer1x/x.hedgeLeverage:null;
 const jlpEquity=factor?x.capital/factor:null;
 const tokens=estimate?x.leverage*jlpEquity/s.market:null;
 $('hedgetable').innerHTML=['BTC','ETH','SOL'].map(c=>{const h=p.hedges?.[c]||{},n=live&&typeof h.unitsPerJlp==='number'?h.unitsPerJlp*tokens:null;return `<tr><th>${c}</th><td>${pct(h.ratio,3)}</td><td class="muted">${pct(h.spotWeight)}</td><td>${fmt(h.unitsPerJlp,8)}</td><td>${n===null?'—':`${n>=0?'Short':'Long'} ${fmt(Math.abs(n),c==='BTC'?6:4)} ${c}`}</td></tr>`;}).join('');
 const hedges=Object.values(p.hedges||{});
 $('totalhedge').textContent=hedges.length===3?pct(hedges.reduce((a,h)=>a+h.ratio,0),3):'—';
 $('strategytime').textContent=!x?'Enter valid leverage and capital':p.hedgesError?'Custody hedge data unavailable':health(s);
 const lastEstimate=$('carryEstimateStatus');
 lastEstimate.hidden=!estimate||live;
 lastEstimate.textContent=lastEstimate.hidden?'':`Last estimate · ${dt(s.fetchedAt)} HKT · Market data delayed`;
 const ids=['carryapr','carryfee','carryfund','carrycost','capitalstructure','marginstructure'];
 if(!estimate){
  ids.forEach(id=>$(id).textContent='—');
  $('carryapr').className='metric';
  $('carryprofit').textContent=!x&&!usingPosition()
   ?'Use JLP leverage 1–10× and HL leverage 1–40×.'
   :'Waiting for fresh, aligned strategy inputs';
  $('ltvstatus').textContent=usingPosition()&&!x&&s.market
   ?'Position equity and leverage must be within the supported range.'
   :'Carry estimates pause when a source is stale.';
  return;
 }
 const fee=x.leverage*s.feeAprPer1x/factor,funding=x.leverage*s.fundingAprPer1x/factor,cost=(x.leverage-1)*s.borrowApr/factor,net=fee+funding-cost;
 $('carryapr').textContent=pct(net);$('carryapr').className='metric '+(live?(net<0?'negative':'positive'):'orange');
 $('carryprofit').textContent=`${usd(net/100*x.capital,2)} / year · ${usd(net/100*x.capital/365,2)} / day · ${usingPosition()?'Modeled HL hedge':'theoretical'}`;
 $('carryfee').textContent=pct(fee);$('carryfund').textContent=`${funding>=0?'+':''}${pct(funding)}`;
 $('carrycost').textContent=cost===0?'0.00% (no debt)':`−${pct(cost)}`;
 const debt=(x.leverage-1)*jlpEquity,notional=x.leverage*jlpEquity,margin=x.capital-jlpEquity;
 $('capitalstructure').textContent=`${usd(notional,2)} / ${usd(debt,2)}`;
 $('marginstructure').textContent=`${usd(jlpEquity,2)} / ${usd(margin,2)}`;
 const ltv=debt/(tokens*s.nav)*100;
 $('ltvstatus').textContent=`Loan LTV ${pct(ltv)} / limit ${pct(s.maxLtv)} · HL hedge leverage ${fmt(x.hedgeLeverage,0)}×${live&&ltv>s.maxLtv?' · Exceeds current JLP Loan limit':''}`;
 $('ltvstatus').className='meta '+(ltv>s.maxLtv?'error':'');
}
function renderCarryChart(){
 const x=settings();
 if(!x){
  const el=$('carrychart');
  el.onpointerleave?.();
  el.onpointermove=el.onpointerleave=el.onclick=null;
  el.innerHTML='<div class="empty">'+(usingPosition()?'Waiting for position valuation':'Enter valid leverage settings')+'</div>';
  return;
 }
 const m=new Map(series.carry_margin_notional_1x||[]),f=new Map(series.carry_funding_1x||[]),b=new Map(series.carry_borrow_apr||[]);
 const daily=$('carryunit').value==='daily',scale=daily?x.capital/100/365:1,carryDays=Number($('carryrange').value);
 const out={net:[],fee:[],fund:[],cost:[]};
 for(const [t,v] of series.carry_fee_1x||[]){if(!m.has(t)||!f.has(t)||!b.has(t))continue;const factor=1+x.leverage*m.get(t)/x.hedgeLeverage,fee=x.leverage*v/factor,fund=x.leverage*f.get(t)/factor,cost=-(x.leverage-1)*b.get(t)/factor;out.net.push([t,fee+fund+cost]);out.fee.push([t,fee]);out.fund.push([t,fund]);out.cost.push([t,cost]);}
 $('carrychartlabel').textContent=`JLP ${fmt(x.leverage,1)}× · HL ${fmt(x.hedgeLeverage,0)}× · ${daily?'USD / day':'APR %'}`;
 const definitions=[
  ['net','Net carry',colors[0]],['fee','Fee yield',colors[1]],
  ['fund','Hedge funding',colors[3]],['cost','Borrowing drag',colors[2]],
 ];
 chart('carrychart',definitions.map(([key,label,color])=>({
  key:'strategy_'+key,label,color,points:out[key].map(([time,value])=>[time,value*scale]),
 })),daily?'USD':'%',false,carryDays);
}
function updatePositionMode(){
 const actual=usingPosition();
 $('leverage').readOnly=$('equity').readOnly=actual;
 if(!actual){
  $('leverage').value=manualSettings.leverage;
  $('equity').value=manualSettings.capital;
 }
 renderStrategy();
 if(Object.keys(series).length)renderCarryChart();
 updateExport();
}
function renderPositionSource(){
 const label=position.syncStatus==='current'?'Posley MCP auto-sync':
  position.syncStatus==='delayed'?'Posley MCP · Position sync delayed':
  position.syncStatus==='pending'?'Posley MCP snapshot · Waiting for position sync':'Posley MCP snapshot';
 const units=fmt(position.jlpUnits,Number.isInteger(position.jlpUnits)?0:6);
 $('positionsource').textContent=`${label} · ${units} JLP · ${fmt(position.borrowedUsdc)} USDC borrowed · ${dt(Date.parse(position.asOf))} HKT`;
}
function getPosition(){
 if(positionRequest)return positionRequest;
 positionRequest=(async()=>{
  try{
   const response=await fetch('/api/jlp/position',{cache:'no-store',signal:AbortSignal.timeout(5000)});
   if(response.status===401){
    if(position){position=null;$('positioncontrols').hidden=true;updatePositionMode();}
    return;
   }
   if(!response.ok)throw new Error();
   const snapshot=await response.json(),asOf=Date.parse(snapshot.asOf);
   if(!Number.isFinite(snapshot.jlpUnits)||snapshot.jlpUnits<=0||
      !Number.isFinite(snapshot.borrowedUsdc)||snapshot.borrowedUsdc<0||!Number.isFinite(asOf))throw new Error();
   if(position&&asOf<Date.parse(position.asOf))throw new Error();
   const changed=!position||position.jlpUnits!==snapshot.jlpUnits||position.borrowedUsdc!==snapshot.borrowedUsdc;
   if(!position)$('useActualPosition').checked=true;
   position=snapshot;
   renderPositionSource();
   $('positioncontrols').hidden=false;
   if(changed&&usingPosition())updatePositionMode();
  }catch{
   if(position?.syncStatus==='current'){
    position={...position,syncStatus:'delayed'};
    renderPositionSource();
   }
  }finally{positionRequest=null;}
 })();
 return positionRequest;
}

let stateRequest=null;
function getState(){
 if(stateRequest)return stateRequest;
 stateRequest=(async()=>{
  try{
   const response=await fetch('/api/jlp/state?view=charts',{cache:'no-store',signal:AbortSignal.timeout(6000)});
   if(!response.ok)throw new Error();
   const previousSettings=settings();
   state=await response.json();
   stateAvailable=true;
   renderState();
   if(usingPosition()&&!previousSettings&&settings()&&Object.keys(series).length)renderCarryChart();
  }catch{
   stateAvailable=false;
   $('health').textContent='Data service unavailable';
   $('health').className='error';
   renderStrategy();
  }
  finally{stateRequest=null;}
 })();
 return stateRequest;
}

function historyStatus(message){
 $('historyStatus').textContent=message;
 $('historyStatus').hidden=!message;
}
async function getHistory(showLoading=false){
 const key=new URLSearchParams({view:'charts',days,carryDays:$('carryrange').value}).toString();
 if(historyController&&historyKey===key)return;
 historyController?.abort();
 const controller=new AbortController();
 historyController=controller;
 historyKey=key;
 if(showLoading)historyStatus('Loading chart history…');
 const timeout=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch('/api/jlp/history?'+key,{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error();
  const data=await response.json();
  if(historyController!==controller)return;
  series=data;
  renderCharts();
  historyStatus('');
 }catch{
  if(historyController===controller)historyStatus('History could not be loaded · retrying');
 }finally{
  clearTimeout(timeout);
  if(historyController===controller)historyController=null;
 }
}

$('refresh').onclick=async()=>{
 const button=$('refresh');
 button.disabled=true;
 await Promise.allSettled([getState(),getHistory(true),getPosition()]);
 button.disabled=false;
};
document.querySelectorAll('[data-days]').forEach(button=>button.onclick=()=>{
 days=Number(button.dataset.days);
 document.querySelectorAll('[data-days]').forEach(item=>{
  const active=item===button;
  item.classList.toggle('active',active);
  item.setAttribute('aria-pressed',String(active));
 });
 updateExport();
 getHistory(true);
});
$('useActualPosition').onchange=updatePositionMode;
$('fundunit').onchange=renderFundingChart;
$('carryrange').onchange=()=>getHistory(true);
$('carryunit').onchange=renderCarryChart;
for(const id of ['leverage','hedgeleverage','equity'])$(id).addEventListener('input',()=>{
 if(!usingPosition()){
  manualSettings.leverage=$('leverage').value;
  manualSettings.capital=$('equity').value;
 }
 renderStrategy();
 if(Object.keys(series).length)renderCarryChart();
 updateExport();
});
updateExport();
getState();
getHistory(true);
getPosition();
setInterval(()=>{if(!document.hidden)getState();},5000);
setInterval(()=>{
 if(document.hidden)return;
 getHistory();
 getPosition();
},15000);
