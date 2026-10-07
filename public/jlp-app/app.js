'use strict';
const $=id=>document.getElementById(id),colors=['#b5ee68','#6bb9ee','#ffba7a','#b49bfa'];
let state={},series={},days=7,historyRequest=0,lastHistory=0;
const hiddenLines={};
try{const saved=JSON.parse(localStorage.getItem('jlp-chart-hidden-lines')||'{}');for(const [id,keys] of Object.entries(saved||{}))if(Array.isArray(keys))hiddenLines[id]=new Set(keys.filter(k=>typeof k==='string'));}catch{}
function saveHiddenLines(){try{localStorage.setItem('jlp-chart-hidden-lines',JSON.stringify(Object.fromEntries(Object.entries(hiddenLines).map(([id,keys])=>[id,[...keys]]))));}catch{}}
function lineLegend(id,sets){
 const legend=$(id).parentElement.querySelector('.legend');
 if(!legend||sets.length<2)return;
 const signature=sets.map(s=>s.key).join('|');
 if(legend.dataset.series!==signature){
  legend.dataset.series=signature;
  legend.innerHTML=sets.map(s=>`<button type="button" class="legend-toggle" data-series="${s.key}" aria-controls="${id}" style="--c:${s.color}"><span class="legend-check" aria-hidden="true"></span>${s.label}</button>`).join('');
 }
 const hidden=hiddenLines[id]||new Set();
 legend.querySelectorAll('button[data-series]').forEach(button=>{const visible=!hidden.has(button.dataset.series);button.setAttribute('aria-pressed',String(visible));button.title=(visible?'Hide ':'Show ')+button.textContent;button.querySelector('.legend-check').textContent=visible?'✓':'−';});
 legend.onclick=e=>{const button=e.target.closest('button[data-series]');if(!button||!legend.contains(button))return;const hidden=hiddenLines[id]||(hiddenLines[id]=new Set()),key=button.dataset.series;hidden.has(key)?hidden.delete(key):hidden.add(key);saveHiddenLines();renderCharts();};
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
 renderActivity();
 renderLiquidations();
 $('coverage').textContent=`Price / borrow records since ${dt(state.collectionStartedAt)} · 90-day fee yield and funding backfill`;
 const hs=['jlpHistory','history_BTC','history_ETH','history_SOL'];
 $('archiveState').textContent=hs.every(k=>state[k]?.fetchedAt&&!state[k]?.error)?'90-day history backfilled':hs.some(k=>state[k]?.error)?'Partial history backfill failed; automatic retry':'History backfill in progress';
}
function chart(id,sets,unit,zero=false,rangeDays=days){
 const el=$(id),start=Date.now()-rangeDays*86400000,end=Date.now();
 lineLegend(id,sets);
 sets=sets.filter(s=>!hiddenLines[id]?.has(s.key));
 if(!sets.length){el.innerHTML='<div class="empty"><span>All lines hidden</span><span>Select a legend item below to show a line.</span></div>';el.onpointermove=null;el.onpointerleave=null;return;}
 sets=sets.map(s=>({...s,points:(series[s.key]||[]).filter(p=>Number.isFinite(p[1])&&p[0]>=start&&p[0]<=end)}));
 const all=sets.flatMap(s=>s.points);
 if(!all.length){el.innerHTML='<div class="empty"><span>No records in this range</span><span>Waiting for collection / backfill</span></div>';el.onpointermove=null;el.onpointerleave=null;return;}
 let ymin=Math.min(...all.map(x=>x[1])),ymax=Math.max(...all.map(x=>x[1]));
 if(zero){ymin=Math.min(0,ymin);ymax=Math.max(0,ymax);}
 const pad=(ymax-ymin)*.12||Math.max(Math.abs(ymax)*.0001,.0001);ymin-=pad;ymax+=pad;
 const W=640,H=230,L=62,R=12,T=15,B=30,x=t=>L+(t-start)/(end-start)*(W-L-R),y=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);
 const nf=v=>unit==='USD'?'$'+fmt(v,4):unit==='USDm'?'$'+fmt(v/1e6,2)+'M':fmt(v,Math.abs(v)<.01?5:2)+'%';
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${el.parentElement.querySelector('h3').textContent} history chart">`;
 for(let i=0;i<5;i++){const yy=T+i*(H-T-B)/4,v=ymax-i*(ymax-ymin)/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="#293843" stroke-dasharray="3 5"/><text x="${L-8}" y="${yy+4}" fill="#94a6b5" text-anchor="end" font-size="12">${nf(v)}</text>`;}
 if(zero)svg+=`<line x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}" stroke="#62737e"/>`;
 for(let i=0;i<4;i++){const t=start+i*(end-start)/3,xx=x(t);const label=new Date(t).toLocaleString('en-GB',{timeZone:'Asia/Hong_Kong',...(rangeDays<=1?{hour:'2-digit',minute:'2-digit'}:{month:'2-digit',day:'2-digit'}),hour12:false});svg+=`<text x="${xx}" y="${H-4}" fill="#94a6b5" font-size="12" text-anchor="${i===0?'start':i===3?'end':'middle'}">${label}</text>`;}
 for(const s of sets){let path='',prev=null;const gap=s.daily?36*3600000:s.settled?5400000:Math.max(150000,rangeDays*86400000/1200*2);for(const p of s.points){if(p[0]<start||p[0]>end)continue;const breakGap=prev&&p[0]-prev[0]>gap;path+=(prev&&!breakGap?'L':'M')+x(p[0]).toFixed(2)+','+y(p[1]).toFixed(2);prev=p;}svg+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;if(s.points.length<=2)for(const p of s.points)svg+=`<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3" fill="${s.color}"/>`;}
 svg+='<line class="cross" stroke="#69818d" y1="15" y2="200" visibility="hidden"/></svg><div class="tip" hidden></div>';
 el.innerHTML=svg;const tip=el.querySelector('.tip'),cross=el.querySelector('.cross');
 el.onpointermove=e=>{const box=el.getBoundingClientRect(),tx=start+((e.clientX-box.left)/box.width*W-L)/(W-L-R)*(end-start),items=[];for(const s of sets){if(!s.points.length)continue;let nearest=s.points.reduce((a,b)=>Math.abs(b[0]-tx)<Math.abs(a[0]-tx)?b:a);const tolerance=s.daily?86400000:s.settled?3600000:90000;if(Math.abs(nearest[0]-tx)<tolerance)items.push(`<div style="color:${s.color}">${s.label}: ${nf(nearest[1])}<br><span style="color:#94a6b5">${dt(nearest[0])}</span></div>`);}if(!items.length){tip.hidden=true;cross.setAttribute('visibility','hidden');return;}tip.hidden=false;tip.innerHTML=items.join('');tip.style.left=Math.min(Math.max(0,e.clientX-box.left+10),box.width-215)+'px';tip.style.top='8px';cross.setAttribute('x1',x(tx));cross.setAttribute('x2',x(tx));cross.setAttribute('visibility','visible');};
 el.onpointerleave=()=>{tip.hidden=true;cross.setAttribute('visibility','hidden');};
}
function renderCharts(){
 renderStrategyCharts();
 renderActivityCharts();
 renderLiquidationChart();
 chart('pricechart',[{key:'market_price',label:'Market price',color:colors[0]},{key:'nav',label:'NAV',color:colors[1]}],'USD');
 chart('premiumchart',[{key:'premium',label:'Premium / discount',color:colors[0]}],'%',true);
 chart('yieldchart',[{key:'jlp_apr_archive',label:'Historical 7-day fee APR',color:colors[0],daily:true},{key:'jlp_apr',label:'Official APR',color:colors[1]},{key:'borrow_apr',label:'Borrow APR',color:colors[2]}],'%');
 const mult=Number($('fundunit').value),original=series;
 series={...series};for(const c of ['BTC','ETH','SOL'])series['funding_'+c]=(series['funding_'+c]||[]).map(([t,v])=>[t,v*mult]);
 chart('fundchart',['BTC','ETH','SOL'].map((c,i)=>({key:'funding_'+c,label:c,color:[colors[0],colors[1],colors[3]][i],settled:true})),'%',true);series=original;
}
function settings(){
 const leverage=Number($('leverage').value),hedgeLeverage=Number($('hedgeleverage').value),capital=Number($('equity').value);
 if(!Number.isFinite(leverage)||leverage<1||leverage>10||!Number.isFinite(hedgeLeverage)||hedgeLeverage<1||hedgeLeverage>40||!Number.isFinite(capital)||capital<1||capital>1e9)return null;
 return {leverage,hedgeLeverage,capital};
}
function query(forHistory=false){const x=settings()||{leverage:2,hedgeLeverage:10};return new URLSearchParams({days:forHistory?Math.max(days,Number($('carryrange').value),Number($('activityrange').value)):days,leverage:x.leverage,hedgeLeverage:x.hedgeLeverage}).toString();}
function renderStrategy(){
 const p=state.pool||{},s=state.strategy||{},x=settings();
 const valid=x&&!s.error&&age(s.fetchedAt)<45&&Object.entries(s.inputTimes||{}).length===4&&Object.values(s.inputTimes).every(t=>age(t)<45)&&!['pool','loan','price','funding'].some(k=>state[k]?.error)&&age(state.price?.sourceAt)<120;
 const factor=x&&typeof s.marginNotionalPer1x==='number'?1+x.leverage*s.marginNotionalPer1x/x.hedgeLeverage:null;
 const jlpEquity=factor?x.capital/factor:null;
 const tokens=valid?x.leverage*jlpEquity/s.market:null;
 $('hedgetable').innerHTML=['BTC','ETH','SOL'].map(c=>{const h=p.hedges?.[c]||{},n=typeof h.unitsPerJlp==='number'&&tokens!==null?h.unitsPerJlp*tokens:null;return `<tr><th>${c}</th><td>${pct(h.ratio,3)}</td><td class="muted">${pct(h.spotWeight)}</td><td>${fmt(h.unitsPerJlp,8)}</td><td>${n===null?'—':`${n>=0?'Short':'Long'} ${fmt(Math.abs(n),c==='BTC'?6:4)} ${c}`}</td></tr>`;}).join('');
 const hedges=Object.values(p.hedges||{});
 $('totalhedge').textContent=hedges.length===3?pct(hedges.reduce((a,h)=>a+h.ratio,0),3):'—';
 $('strategytime').textContent=!x?'Enter valid leverage and capital':p.hedgesError?'Custody hedge data unavailable':health(s);
 const ids=['carryapr','carryfee','carryfund','carrycost','capitalstructure','marginstructure'];
 if(!valid){ids.forEach(id=>$(id).textContent='—');$('carryprofit').textContent=!x?'Use JLP leverage 1–10× and HL leverage 1–40×.':'Waiting for fresh, aligned strategy inputs';$('ltvstatus').textContent='Carry estimates pause when a source is stale.';return;}
 const fee=x.leverage*s.feeAprPer1x/factor,funding=x.leverage*s.fundingAprPer1x/factor,cost=(x.leverage-1)*s.borrowApr/factor,net=fee+funding-cost;
 $('carryapr').textContent=pct(net);$('carryapr').className='metric '+(net<0?'negative':'positive');
 $('carryprofit').textContent=`${usd(net/100*x.capital,2)} / year · ${usd(net/100*x.capital/365,2)} / day · theoretical`;
 $('carryfee').textContent=pct(fee);$('carryfund').textContent=`${funding>=0?'+':''}${pct(funding)}`;
 $('carrycost').textContent=cost===0?'0.00% (no debt)':`−${pct(cost)}`;
 const debt=(x.leverage-1)*jlpEquity,notional=x.leverage*jlpEquity,margin=x.capital-jlpEquity;
 $('capitalstructure').textContent=`${usd(notional,2)} / ${usd(debt,2)}`;
 $('marginstructure').textContent=`${usd(jlpEquity,2)} / ${usd(margin,2)}`;
 const ltv=debt/(tokens*s.nav)*100;
 $('ltvstatus').textContent=`Loan LTV ${pct(ltv)} / limit ${pct(s.maxLtv)} · HL hedge leverage ${fmt(x.hedgeLeverage,0)}×${ltv>s.maxLtv?' · Exceeds current JLP Loan limit':''}`;
 $('ltvstatus').className='meta '+(ltv>s.maxLtv?'error':'');
}
function renderStrategyCharts(){
 chart('hedgechart',['BTC','ETH','SOL'].map((c,i)=>({key:'hedge_ratio_'+c,label:c,color:[colors[0],colors[1],colors[3]][i]})),'%');
 const x=settings();if(!x){$('carrychart').innerHTML='<div class="empty">Enter valid leverage settings</div>';return;}
 const original=series;series={...series};const m=new Map(series.carry_margin_notional_1x||[]),f=new Map(series.carry_funding_1x||[]),b=new Map(series.carry_borrow_apr||[]);
 const daily=$('carryunit').value==='daily',scale=daily?x.capital/100/365:1,carryDays=Number($('carryrange').value);
 const out={net:[],fee:[],fund:[],cost:[]};
 for(const [t,v] of series.carry_fee_1x||[]){if(!m.has(t)||!f.has(t)||!b.has(t))continue;const factor=1+x.leverage*m.get(t)/x.hedgeLeverage,fee=x.leverage*v/factor,fund=x.leverage*f.get(t)/factor,cost=-(x.leverage-1)*b.get(t)/factor;out.net.push([t,fee+fund+cost]);out.fee.push([t,fee]);out.fund.push([t,fund]);out.cost.push([t,cost]);}
 for(const [k,v] of Object.entries(out))series['strategy_'+k]=v.map(([t,y])=>[t,y*scale]);
 $('carrychartlabel').textContent=`JLP ${fmt(x.leverage,1)}× · HL ${fmt(x.hedgeLeverage,0)}× · ${daily?'USD / day':'APR %'}`;
 chart('carrychart',[{key:'strategy_net',label:'Net carry',color:colors[0]},{key:'strategy_fee',label:'Fee yield',color:colors[1]},{key:'strategy_fund',label:'Hedge funding',color:colors[3]},{key:'strategy_cost',label:'Borrowing drag',color:colors[2]}],daily?'USD':'%',false,carryDays);
 series=original;
}
async function getState(){try{const r=await fetch('/api/jlp/state',{cache:'no-store'});if(!r.ok)throw Error();state=await r.json();renderState();}catch{$('health').textContent='Data service unavailable';$('health').className='error';}}
async function getHistory(){const request=++historyRequest;try{const r=await fetch('/api/jlp/history?'+query(true),{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();if(request!==historyRequest)return;series=data;lastHistory=Date.now();renderCharts();}catch{if(request===historyRequest)$('archiveState').textContent='History could not be loaded';}}
$('refresh').onclick=async()=>{const b=$('refresh');b.disabled=true;await Promise.allSettled([getState(),getHistory()]);b.disabled=false;};
document.querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>{days=Number(b.dataset.days);document.querySelectorAll('[data-days]').forEach(x=>{const active=x===b;x.classList.toggle('active',active);x.setAttribute('aria-pressed',String(active));});$('export').href='/api/jlp/export.csv?'+query();getHistory();});
$('fundunit').onchange=renderCharts;
$('carryrange').onchange=()=>{renderStrategyCharts();getHistory();};
$('carryunit').onchange=renderStrategyCharts;
for(const id of ['leverage','hedgeleverage','equity'])$(id).addEventListener('input',()=>{renderStrategy();renderStrategyCharts();$('export').href='/api/jlp/export.csv?'+query();});
$('export').href='/api/jlp/export.csv?'+query();
getState();getHistory();setInterval(getState,5000);setInterval(()=>{if(!document.hidden)getHistory();},15000);

function renderActivity(){
 const a=state.activity||{},t=a.totals||{},money=v=>typeof v==='number'?usd(v/1e6,2)+'M':'—';
 $('activitytime').textContent=health(a);
 $('perpsvolume').textContent=money(t.volume24h);$('perpsoi').textContent=money(t.grossOi);
 $('perpsoneside').textContent=money(t.oneSidedOi);$('perpslongshare').textContent=pct(t.longShare);
 $('activitytable').innerHTML=['BTC','ETH','SOL'].map(coin=>{const c=a.coins?.[coin]||{};return `<tr><th>${coin}</th><td>${money(c.volume24h)}</td><td>${money(c.longOi)}</td><td>${money(c.shortOi)}</td></tr>`;}).join('');
}
function renderActivityCharts(){
 chart('volumechart',[{key:'perps_volume24h_TOTAL',label:'Total',color:colors[0]},...['BTC','ETH','SOL'].map((c,i)=>({key:'perps_volume24h_'+c,label:c,color:[colors[1],colors[3],colors[2]][i]}))],'USDm',false,Number($('activityrange').value));
 chart('oichart',[{key:'perps_longOi_TOTAL',label:'Long OI',color:colors[0]},{key:'perps_shortOi_TOTAL',label:'Short OI',color:colors[2]},{key:'perps_grossOi_TOTAL',label:'Gross OI',color:colors[1]},{key:'perps_oneSidedOi_TOTAL',label:'Gross / 2',color:colors[3]}],'USDm',false,Number($('activityrange').value));
}

$('activityrange').onchange=()=>{renderActivityCharts();getHistory();};

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let liquidationInitialized=false,liquidationSeen=new Set(),liquidationAlerts=[];
try{const ids=JSON.parse(localStorage.getItem('jlp-liquidation-seen')||'[]');if(Array.isArray(ids)&&ids.length){liquidationSeen=new Set(ids);liquidationInitialized=true;}}catch{}
function renderLiquidations(){
 const feed=state.liquidations||{},t=feed.totals||{},events=feed.events||[],fresh=liquidationInitialized?events.filter(e=>!liquidationSeen.has(e.eventId)):[];
 if(feed.fetchedAt){liquidationInitialized=true;for(const e of events)liquidationSeen.add(e.eventId);liquidationSeen=new Set([...liquidationSeen].slice(-2000));try{localStorage.setItem('jlp-liquidation-seen',JSON.stringify([...liquidationSeen]));}catch{}}
 if(fresh.length){liquidationAlerts.push(...fresh.reverse());liquidationAlerts=liquidationAlerts.slice(-200);}
 const healthy=feed.connected&&!feed.error&&age(feed.fetchedAt)<120,status=!feed.fetchedAt?'CONNECTING':feed.error?'FEED ERROR':feed.backlog?'CATCHING UP':healthy?'CONNECTED':'STALE';
 $('liqstatus').textContent=status;$('liqstatus').className='tag '+(healthy&&!feed.backlog?'positive':'error');
 const valid=feed.fetchedAt&&healthy&&!feed.backlog;
 $('liqcount').textContent=feed.fetchedAt?fmt(t.count,0):'—';
 const lowerBound=t.undecodedCount?'≥ ':'';
 $('liqnotional').textContent=lowerBound+usd(t.notionalUsd,2);$('liqsplit').textContent=lowerBound+usd(t.longUsd,2)+' / '+lowerBound+usd(t.shortUsd,2);$('liqfees').textContent=lowerBound+usd(t.liquidationFeeUsd,2);
 $('liqcoverage').textContent=feed.coverageSince?`Tracking since ${dt(feed.coverageSince)} HKT · ${feed.partial24h?'Partial 24h coverage':'Full locally monitored 24h window'}`:'Waiting for a verified collection checkpoint.';
 $('liqhealth').textContent=feed.error?`Feed unavailable: ${feed.error}. Last observed totals are retained; coverage is incomplete.`:feed.backlog?`Catching up: ${fmt(feed.backlog,0)} transactions remaining. Totals are incomplete.`:`${health(feed,120)} · Chain finalization and polling add delay${t.undecodedCount?` · ${t.undecodedCount} event(s) have unavailable details`:''}`;
 $('liqhealth').className='meta '+(valid?'':'error');
 $('liqalert').hidden=!liquidationAlerts.length;
 $('liqalertitems').innerHTML=liquidationAlerts.map(e=>`<div><strong>New liquidation</strong> · ${escapeHtml(e.market||'Details unavailable')} ${escapeHtml(e.side||'')} · ${usd(e.sizeUsd,2)} · ${dt(e.blockTime?e.blockTime*1000:e.observedAt*1000)}</div>`).join('');
 const market=$('liqmarket').value,side=$('liqside').value,filtered=events.filter(e=>(market==='all'||e.market===market)&&(side==='all'||e.side===side));
 $('liqevents').innerHTML=filtered.length?filtered.map(e=>`<tr class="${Date.now()-e.observedAt*1000<120000?'new-liquidation':''}"><th>${dt(e.blockTime?e.blockTime*1000:e.observedAt*1000)}${!e.blockTime?' (observed)':''}</th><td>${escapeHtml(e.market||'Unknown')}</td><td class="${e.side==='long'?'negative':'positive'}">${escapeHtml(e.side||'Unknown')}</td><td>${usd(e.sizeUsd,2)}</td><td>${usd(e.priceUsd,4)}</td><td>${usd(e.liquidationFeeUsd,2)}</td><td><a href="https://solscan.io/tx/${encodeURIComponent(e.signature)}" target="_blank" rel="noopener">View ↗</a>${e.decoded?'':' · Details unavailable'}</td></tr>`).join(''):`<tr><td colspan="7">${!feed.fetchedAt?'Connecting to Jupiter chain events…':!valid?'No matching records loaded. Feed coverage is incomplete.':events.length?'No events match these filters.':'No liquidation events observed since collection began.'}</td></tr>`;
 $('liqtablemeta').textContent=`Showing ${filtered.length} matching event(s) from the latest ${events.length} · ${fmt(feed.eventCount,0)} total recorded · All recorded events are available in the export.`;
 renderLiquidationChart();
}
function renderLiquidationChart(){
 const f=state.liquidations||{},el=$('liqchart');
 if(!f.coverageSince||!f.fetchedAt){el.innerHTML='<div class="empty">Waiting for chain-event coverage</div>';return;}
 const start=Math.max(f.coverageSince,Date.now()-86400000),end=Math.max(start,Math.min(f.backlog?f.checkpointAt:f.fetchedAt,Date.now()));
 let long=0,short=0;const lp=[[start,0]],sp=[[start,0]];
 for(const [t,l,s] of f.minuteBuckets||[]){if(t+60000<start||t>end)continue;const stamp=Math.max(start,t);lp.push([stamp,long]);sp.push([stamp,short]);long+=l;short+=s;lp.push([stamp,long]);sp.push([stamp,short]);}
 lp.push([end,long]);sp.push([end,short]);const original=series;
 series={...series,liq_long:lp,liq_short:sp};
 chart('liqchart',[{key:'liq_long',label:'Long liquidations',color:colors[2],daily:true},{key:'liq_short',label:'Short liquidations',color:colors[1],daily:true}],'USDm',true,1);
 series=original;
}
$('liqmarket').onchange=renderLiquidations;$('liqside').onchange=renderLiquidations;
$('liqdismiss').onclick=()=>{liquidationAlerts=[];$('liqalert').hidden=true;};
