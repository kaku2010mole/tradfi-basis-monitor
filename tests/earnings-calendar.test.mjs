import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { zipSync, strToU8 } from 'fflate';

const source = stripTypeScriptTypes(await readFile(new URL('../app/lib/earningsCalendar.ts', import.meta.url), 'utf8')).replace('"fflate"', JSON.stringify(import.meta.resolve('fflate')));
const lib = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const listing = (base, exchange='Bitget') => ({base, exchange, symbol:base+'USDT'});
const directory = lib.parseUsDirectory('Symbol|Security Name|Test Issue|ETF\nAAPL|Apple|N|N\nMSTR|Strategy|N|N\nSTRC|Strategy Preferred|N|N\nSOXL|Leveraged semiconductor ETF|N|Y\nBRK.B|Berkshire|N|N\nACN|Accenture|N|N\nZZZT|Test security|Y|N');
const universe = lib.mapEarningsUniverse([
  listing('AAPL'), listing('AAPL','Binance'), listing('SOXL'), listing('STRC'), listing('MSTR'), listing('BRKB'), listing('ACNSTOCK'),
  listing('HANMI'), listing('HANMI','Binance'), listing('SONY'), listing('JPSONY'), listing('SKHY'), listing('SKHYNIX'),
  listing('FASTRETAILING'), listing('KIA'), listing('SSBIOLOGICS'), listing('USDJPY'), listing('QQ_UNKNOWN'), listing('NETEASE'),
], directory);
const issuer = id => universe.issuers.find(i=>i.id===id);
const reset = () => { globalThis.__EARNINGS_SOURCE_CACHE__=new Map();globalThis.__EARNINGS_INFLIGHT__=new Map(); };

test('live-listing universe deduplicates venues, normalizes aliases, and excludes ETFs', () => {
  assert.equal(issuer('US:AAPL').contracts.length,2);
  assert.equal(issuer('US:MSTR').contracts.length,2);
  assert.ok(issuer('US:ACN'));assert.ok(issuer('US:BRK-B'));
  assert.equal(issuer('JP:6758').contracts.length,2);
  assert.equal(issuer('KR:000660').contracts.length,2);
  assert.equal(issuer('JP:9983').company,'Fast Retailing');
  assert.ok(universe.excluded.some(c=>c.symbol==='SOXLUSDT'&&/ETF/.test(c.reason)));
  assert.ok(universe.excluded.some(c=>c.symbol==='USDJPYUSDT'));
  assert.ok(universe.excluded.some(c=>c.symbol==='NETEASEUSDT'));
  assert.deepEqual(universe.unresolved.map(c=>c.symbol),['QQ_UNKNOWNUSDT']);
  assert.equal(issuer('KR:042700').company,'Hanmi Semiconductor');
  assert.equal(issuer('KR:128940').company,'Hanmi Pharm');
});
test('HKT conversion handles Korea, U.S. daylight saving and calendar rollover without false midnight', () => {
  assert.deepEqual(lib.hktParts(lib.localTimestamp('2026-10-29','10:00','Asia/Seoul')),{date:'2026-10-29',time:'09:00'});
  assert.deepEqual(lib.hktParts(lib.localTimestamp('2026-10-30','16:00','America/New_York')),{date:'2026-10-31',time:'04:00'});
  assert.deepEqual(lib.hktParts(lib.localTimestamp('2026-11-02','16:00','America/New_York')),{date:'2026-11-03',time:'05:00'});
  assert.equal(lib.localTimestamp('2026-02-30','10:00','Asia/Seoul'),null);
  assert.equal(lib.localTimestamp('2026-10-29','--:--','Asia/Seoul'),null);
});
test('Nasdaq estimated dates preserve unknown time and shift after-close into next HKT month', () => {
  const rows=lib.parseNasdaq([{symbol:'AAPL',time:'time-after-hours',fiscalQuarterEnding:'Sep/2026'},{symbol:'BRK.B',time:'time-not-supplied'}],'2026-10-31',universe.issuers,'https://www.nasdaq.com/market-activity/earnings');
  assert.equal(rows[0].calendarDate,'2026-11-01'); assert.equal(rows[0].reportDate,'2026-10-31');
  assert.equal(rows[0].startsAt,null);assert.equal(rows[0].timeHkt,null);assert.equal(rows[0].status,'estimated');
  assert.equal(rows[1].calendarDate,'2026-10-31'); assert.equal(rows[1].session,'unknown');
});
const header=['Scheduled Dates for Earnings Announcements','Code','Company','Issue Name','Fiscal Year-end','Industry','','','Fiscal Year/Quarter'];
test('JPX parses Excel dates and refuses undecided and invalid dates', () => {
  const rows=[header,['46303','9983','','','','','','','Fiscal year'],['Undecided','6758']];
  const events=lib.parseJpxRows(rows,universe.issuers,'https://www.jpx.co.jp/example.xlsx');
  assert.equal(events.length,1);assert.equal(events[0].reportDate,'2026-10-08');assert.equal(events[0].timeHkt,null);
  assert.equal(events[0].status,'confirmed');assert.throws(()=>lib.parseJpxRows([['broken']],universe.issuers,''));
});
test('XLSX reader preserves missing columns, shared and inline strings, and never executes formulas', () => {
  const bytes=zipSync({'xl/sharedStrings.xml':strToU8('<sst><si><t>Code</t></si><si><r><t>Fast </t></r><r><t>Retailing</t></r></si></sst>'),'xl/worksheets/sheet1.xml':strToU8('<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Fiscal year</t></is></c></row><row><c r="A2"><v>9983</v></c><c r="B2" t="s"><v>1</v></c><c r="C2"><f>HYPERLINK("https://example.invalid")</f></c></row></worksheet>')});
  const rows=lib.xlsxRows(bytes);assert.equal(rows[0][0],'Code');assert.equal(rows[0][1],undefined);assert.equal(rows[0][2],'Fiscal year');assert.equal(rows[1][1],'Fast Retailing');assert.equal(rows[1][2],'');
});
const kindRow=(title,time='10:00',code='00027')=>`<tr><td>1</td><td><a onclick="companysummary_open('${code}')">Company</a></td><td>${title}</td><td>Seoul</td><td>2026-10-30</td><td>${time}</td></tr>`;
test('KIND includes earnings, deduplicates translations, and excludes NDRs / corporate days', () => {
  const html='목록 '+kindRow('2026년 3분기 경영실적 발표')+kindRow('3Q26 Earnings Announcement','--:--')+kindRow('Governance NDR','11:00')+kindRow('Corporate Day','11:00');
  const events=lib.parseKind(html,universe.issuers,'https://kind.krx.co.kr/');
  assert.equal(events.length,1);assert.equal(events[0].timeHkt,'09:00');assert.equal(events[0].kind,'earnings_call');
  assert.equal(lib.parseKind('목록 '+kindRow('3Q26 Earnings Announcement','--:--'),universe.issuers,'')[0].startsAt,null);
});
test('all new Korean and Japanese contracts have explicit issuer mappings',()=>{
  for(const base of ['KAKAO','KBFG','SSBIOLOGICS','LGENERGY','KIA','MURATA','TOYOTA','TAIYOYUDEN','FASTRETAILING','JPMUFG','JPSONY']) {
    assert.equal(lib.mapEarningsUniverse([listing(base)],[]).issuers.length,1,base);
  }
});

test('exchange aliases match their listed U.S. issuer instead of silently dropping contracts',()=>{
  const result=lib.mapEarningsUniverse(['BBX','QNTX','USDEX'].map(b=>listing(b,'Binance')),[{symbol:'BB',company:'BlackBerry',etf:false},{symbol:'QNT',company:'Quantinuum',etf:false},{symbol:'USDE',company:'StablecoinX',etf:false}]);
  assert.deepEqual(result.issuers.map(i=>i.code),['BB','QNT','USDE']);assert.deepEqual(result.unresolved,[]);
});
test('company IR dates are parsed from HTML and unreadable payloads are never counted as complete',()=>{
  const events=lib.parseBiologics('<h4>IR Events</h4><p>Q3 Earnings Release</p><span class="date">2026.10.21</span>',issuer('KR:207940'));
  assert.equal(events[0].calendarDate,'2026-10-21');assert.equal(events[0].status,'confirmed');assert.equal(events[0].timeHkt,null);
  assert.throws(()=>lib.parseBiologics('{"events":[]}',issuer('KR:207940')),/incomplete/);
});
test('previously verified public observations survive data-centre rejection without masquerading as live',()=>{
  const all=lib.mapEarningsUniverse(['KIA','SKHYNIX','KAKAO','SONY','LGENERGY'].map(b=>listing(b)),[]).issuers;
  assert.deepEqual(lib.verifiedScheduleFallback(all,[]),[]);
  const rows=lib.verifiedScheduleFallback(all,['KRX KIND earnings','Sony IR']);
  assert.equal(rows.length,6);assert.ok(rows.every(e=>e.stale&&e.checkedAt===Date.parse('2026-10-16T03:47:35Z')));
  assert.equal(rows.find(e=>e.code==='000660').timeHkt,'08:00');
  assert.equal(rows.find(e=>e.code==='000270').timeHkt,null);
  assert.equal(rows.find(e=>e.code==='6758'&&e.kind==='results').timeHkt,'14:30');
  assert.equal(rows.find(e=>e.code==='6758'&&e.kind==='earnings_call').timeHkt,'15:30');
});

test('complete scan matches all three markets and retains failed source observations as stale', async()=>{
  const fetchBefore=globalThis.fetch;reset();
  const jpRows=[header,['46303','9983','','','','','','','Fiscal year']];
  const shared=jpRows.flat(); const strings='<sst>'+shared.map(s=>`<si><t>${s}</t></si>`).join('')+'</sst>';
  let index=0;const worksheet='<worksheet>'+jpRows.map((r,n)=>'<row>'+r.map((_,c)=>`<c r="${String.fromCharCode(65+c)}${n+1}" t="s"><v>${index++}</v></c>`).join('')+'</row>').join('')+'</worksheet>';
  const workbook=zipSync({'xl/sharedStrings.xml':strToU8(strings),'xl/worksheets/sheet1.xml':strToU8(worksheet)});
  let fail=false;
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('exchangeInfo'))return Response.json({symbols:[{symbol:'AAPLUSDT',baseAsset:'AAPL',status:'TRADING',contractType:'TRADIFI_PERPETUAL',underlyingType:'EQUITY'}]});
    if(url.includes('/contracts?'))return Response.json({code:'00000',data:['KIA','FASTRETAILING','AAPL','SOXL'].map(baseCoin=>({baseCoin,symbol:baseCoin+'USDT',symbolStatus:'normal',symbolType:'perpetual',isRwa:'YES'}))});
    if(url.includes('nasdaqlisted.txt'))return new Response('Symbol|Security Name|Test Issue|ETF\nAAPL|Apple|N|N\nSOXL|ETF|N|Y');
    if(url.includes('otherlisted.txt'))return new Response('ACT Symbol|Security Name|Test Issue|ETF\nIBM|IBM|N|N');
    if(url.includes('api.nasdaq.com')){const date=new URL(url).searchParams.get('date'); if(fail&&date==='2026-10-15')throw Error('timeout');return Response.json({status:{rCode:200},data:{rows:date==='2026-10-15'?[{symbol:'AAPL',time:'time-after-hours'}]:null}});}
    if(url.endsWith('.xlsx'))return new Response(workbook);
    if(url.includes('www.jpx.co.jp'))return new Response('<a href="/list.xlsx">Official</a>');
    if(url.includes('kind.krx.co.kr'))return new Response('목록 '+kindRow('3Q26 Earnings Announcement'));
    throw Error('Unexpected '+url);
  };
  try {
    const first=await lib.scanEarnings('2026-10');assert.deepEqual(first.warnings,[]);assert.equal(first.events.length,3);assert.equal(first.scannedContracts,5);assert.equal(first.trackedContracts,4);
    assert.equal(first.events.find(e=>e.code==='AAPL').calendarDate,'2026-10-16');assert.equal(first.events.find(e=>e.code==='AAPL').contracts.length,2);
    reset();fail=true;const second=await lib.scanEarnings('2026-10',first);assert.equal(second.events.length,3);assert.equal(second.events.find(e=>e.code==='AAPL').stale,true);assert.ok(second.warnings.some(w=>w.includes('2026-10-15')));
  }finally{globalThis.fetch=fetchBefore;reset();}
});

test('page keeps dividends independent and exposes earnings filtering, disclosure and stale caching', async()=>{
  const page=await readFile(new URL('../app/dividends/page.tsx',import.meta.url),'utf8');
  for(const text of ['/api/dividend-calendar','/api/earnings-calendar','Earnings events','Filter market','Filter exchange','Close earnings details','earningsRequestId','Earnings source','No date found this month'])assert.ok(page.includes(text),text);
  assert.match(page,/setInterval\(refresh, 5 \* 60_000\)/);assert.match(page,/no midnight time is assumed/);assert.match(page,/aria-expanded=\{expanded\}/);
});
