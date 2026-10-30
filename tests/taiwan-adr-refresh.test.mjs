import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { appendStudy, adrInput, completedAdrPoints } from '../scripts/refresh-taiwan-adr-study.mjs';
const read = path => readFile(new URL(path, import.meta.url),'utf8');
const current = JSON.parse(await read('../app/data/taiwanAdrStudy.json'));
const audit = JSON.parse(await read('./fixtures/taiwan-adr-refresh-2026-10-28.json'));
// Freeze the original Oct 28 audit (including its subsequently repaired ADR
// anchor) so later refreshes retain this historical regression test.
const sample = { ...current, asOf:'2026-10-28', dates:current.dates.slice(0,62), adrReturns:current.adrReturns.slice(0,62), returns0930:Object.fromEntries(Object.entries(current.returns0930).map(([code,values])=>[code,values.slice(0,62)])), refresh:{excluded:[{date:'2026-10-23',reason:'No verified cash half-hour bars'}]} };
for (const row of audit.adrRows) { const i = sample.dates.indexOf(row.date); if (i >= 0) sample.adrReturns[i] = row.adrReturn; }
const model = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await read('../app/lib/taiwanAdrStudy.ts'))).toString('base64'));
const calendar = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await read('../app/lib/taiwanStockBasis.ts'))).toString('base64'));

test('original Oct 28 snapshot remains reproducible from its frozen audit',()=>{
  assert.equal(sample.asOf,'2026-10-28'); assert.equal(sample.dates.length,62);
  assert.deepEqual(sample.dates.slice(57),['2026-10-20','2026-10-21','2026-10-22','2026-10-27','2026-10-28']);
  assert.equal(new Set(sample.dates).size,62);
  assert.equal(sample.adrReturns.length,62);
  for(const [code,values] of Object.entries(sample.returns0930)) {
    assert.equal(values.length,62);
    assert.equal(model.adrStudyCoverage(sample,code).n,['2317','2454'].includes(code)?57:62);
    assert.equal(model.adrStudyCoverage(sample,code).end,'2026-10-28');
  }
  const old={...sample,asOf:'2026-10-19',dates:sample.dates.slice(0,57),adrReturns:sample.adrReturns.slice(0,57),returns0930:Object.fromEntries(Object.entries(sample.returns0930).map(([code,values])=>[code,values.slice(0,57)]))};
  const copy=structuredClone(old), rebuilt=appendStudy(old,audit.adrRows,audit.cash,'2026-10-28');
  assert.deepEqual(old,copy,'append must not mutate its input');
  assert.deepEqual(rebuilt.dates,sample.dates); assert.deepEqual(rebuilt.returns0930,sample.returns0930); assert.deepEqual(rebuilt.adrReturns,sample.adrReturns);
});

test('new observations are audited against real completed bars; Oct 23 missing data is explicit',()=>{
  assert.deepEqual(sample.refresh.excluded,[{date:'2026-10-23',reason:'No verified cash half-hour bars'}]);
  for(const adr of audit.adrRows) {
    assert.ok(adr.anchor.timestamp <= adr.anchorTarget); assert.ok(adr.preOpen.timestamp <= adr.cutoff);
    assert.equal(adr.adrReturn,adr.preOpen.price/adr.anchor.price-1);
    for(const code of Object.keys(sample.returns0930)) {
      const row=audit.cash[code].find(r=>r.date===adr.date);
      if(adr.date==='2026-10-23') {assert.equal(row.excluded,'missing_half_hour_bars');continue;}
      const i=sample.dates.indexOf(row.date);
      assert.equal(row.previousDate,adr.previousDate);
      assert.equal(row.firstBar.t,Date.parse(`${row.date}T09:00:00+08:00`)/1000);
      assert.equal(row.secondBar.t,row.firstBar.t+1800);
      assert.equal(sample.returns0930[code][i],row.firstBar.close/row.previousClose-1);
    }
  }
  for(const [direction,threshold,n]of[['up',.01,22],['up',.02,13],['down',.01,19],['down',.02,11]]) assert.equal(model.adrCohort(sample,direction,threshold).length,n);
});

test('cutoff excludes an unfinished session and respects Taiwan holidays',()=>{
  const cutoff=time=>new Date(calendar.latestTaiwanCashClose(Date.parse(time)-30*60000,[calendar.TWSE_2026])).toISOString().slice(0,10);
  assert.equal(cutoff('2026-10-28T09:00:00+08:00'),'2026-10-27');
  assert.equal(cutoff('2026-10-28T13:40:00+08:00'),'2026-10-27');
  assert.equal(cutoff('2026-10-28T17:00:00+08:00'),'2026-10-28');
  assert.equal(cutoff('2026-10-26T17:00:00+08:00'),'2026-10-23');
  const base={asOf:'2026-10-27',dates:['2026-10-27'],adrReturns:[.01],returns0930:{X:[.02]}};
  assert.equal(appendStudy(base,[{date:'2026-10-28',previousDate:'2026-10-27',adrReturn:.03}],{X:[{date:'2026-10-28',previousDate:'2026-10-27',return0930:.01}]},'2026-10-27').dates.length,1);
  assert.throws(()=>appendStudy(base,[{date:'2026-10-28',excluded:'missing_ADR_history'}],{},'2026-10-28'),/cannot yet be verified/);
});

test('ADR predictor never consumes an unfinished/future hourly close, or bridges a corporate action',()=>{
  const t=Date.parse('2026-10-28T07:00:00+08:00')/1000;
  const payload={chart:{result:[{meta:{symbol:'TSM',currency:'USD'},timestamp:[t-86400,t,t+1800,t+3599],indicators:{quote:[{open:[100,102,103,104],close:[101,103,104,999]}]}}]}};
  const points=completedAdrPoints(payload);
  assert.equal(points.length,3); assert.equal(points.at(-1).timestamp,t+5400);
  const value=adrInput('2026-10-28','2026-10-27',points);
  assert.equal(value.preOpen.price,104); assert.equal(value.anchor.price,101);
  assert.equal(adrInput('2026-10-28','2026-10-27',points,['2026-10-27']).excluded,'ADR_corporate_action');
  assert.equal(adrInput('2026-11-10','2026-11-09',points).excluded,'missing_ADR_history');
  assert.throws(()=>completedAdrPoints({chart:{result:[{meta:{symbol:'UMC',currency:'USD'}}]}}),/identity/);
});
