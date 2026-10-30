import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { latestStudyDate, repairAdrAnchors, appendStudy } from '../scripts/refresh-taiwan-adr-study.mjs';
import { parseChart, alignCashReturns } from '../scripts/extend-taiwan-adr-study.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const sample = JSON.parse(await read('../app/data/taiwanAdrStudy.json'));
const audit = JSON.parse(await read('./fixtures/taiwan-adr-refresh-2026-10-30.json'));
const oldAudit = JSON.parse(await read('./fixtures/taiwan-adr-refresh-2026-10-28.json'));
const { TWSE_2026 } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await read('../app/lib/taiwanStockBasis.ts'))).toString('base64'));

test('October 29 and 30 add verified 09:30 returns for all ten stocks without changing historical cash', () => {
  assert.equal(sample.asOf, '2026-10-30');
  assert.equal(sample.dates.length, 64);
  assert.deepEqual(sample.dates.slice(62), ['2026-10-29', '2026-10-30']);
  assert.equal(new Set(sample.dates).size, 64);
  assert.equal(sample.adrReturns.length, 64);
  assert.deepEqual(sample.refresh.excluded, []);
  const prior = { ...sample, asOf:'2026-10-28', dates:sample.dates.slice(0,62), adrReturns:sample.adrReturns.slice(0,62), returns0930:Object.fromEntries(Object.entries(sample.returns0930).map(([code,values])=>[code,values.slice(0,62)])) };
  for (const row of oldAudit.adrRows) { const i = prior.dates.indexOf(row.date); if (i >= 0) prior.adrReturns[i] = row.adrReturn; }
  const before = structuredClone(prior);
  const repaired = repairAdrAnchors(prior, audit.adrRows, audit.cash);
  const rebuilt = appendStudy(repaired.sample, audit.adrRows, audit.cash, '2026-10-30');
  assert.deepEqual(prior, before);
  assert.deepEqual(rebuilt.dates, sample.dates);
  assert.deepEqual(rebuilt.adrReturns, sample.adrReturns);
  assert.deepEqual(rebuilt.returns0930, sample.returns0930);
  for (const [code, values] of Object.entries(sample.returns0930)) {
    assert.equal(values.length, 64);
    assert.equal(values.filter(Number.isFinite).length, ['2317','2454'].includes(code) ? 59 : 64);
    assert.deepEqual(values.slice(0,62), before.returns0930[code]);
    for (const date of ['2026-10-29','2026-10-30']) {
      const row = audit.cash[code].find(row => row.date === date);
      assert.equal(row.excluded, undefined);
      assert.ok(row.previousDate < date);
      assert.equal(row.firstBar.t, Date.parse(`${date}T09:00:00+08:00`)/1000);
      assert.equal(row.secondBar.t, row.firstBar.t + 1800);
      assert.equal(row.firstBar.open, row.dailyOpen);
      assert.equal(row.secondBar.close, row.hourlyClose);
      assert.equal(values[sample.dates.indexOf(date)], row.firstBar.close/row.previousClose-1);
      assert.ok(row.secondBar.t + 1800 <= Date.parse(audit.updatedAt)/1000);
    }
  }
});

test('the repaired Oct 27 predictor uses Oct 22 rather than a zero-volume holiday placeholder', () => {
  assert.equal(audit.corrections.length, 1);
  assert.deepEqual(sample.refresh.corrections, audit.corrections);
  const c = audit.corrections[0];
  assert.equal(c.date, '2026-10-27'); assert.equal(c.previousDate, '2026-10-22');
  assert.equal(c.oldAdrReturn, oldAudit.adrRows.find(row => row.date === c.date).adrReturn);
  assert.equal(sample.adrReturns[sample.dates.indexOf(c.date)], 427/426.5-1);
  for (const adr of audit.adrRows.filter(row => row.adrReturn !== undefined)) {
    assert.ok(adr.anchor.timestamp <= adr.anchorTarget);
    assert.ok(adr.preOpen.timestamp <= adr.cutoff);
    assert.equal(adr.adrReturn, adr.preOpen.price/adr.anchor.price-1);
    assert.equal(sample.adrReturns[sample.dates.indexOf(adr.date)], adr.adrReturn);
  }
  const base = {dates:['2026-10-27'],adrReturns:[.04],returns0930:{X:[.01]}};
  assert.throws(() => repairAdrAnchors(base,[{date:'2026-10-27',previousDate:'2026-10-22',adrReturn:.001}],{}), /Cannot verify/);
  assert.equal(base.adrReturns[0], .04);
});

test('daily parsing skips zero-volume placeholders while keeping actual prior close alignment', () => {
  const dates = ['2026-10-22','2026-10-23','2026-10-27'];
  const timestamps = dates.map(date => Date.parse(`${date}T09:00:00+08:00`)/1000);
  const payload = {chart:{result:[{meta:{symbol:'2330.TW',currency:'TWD'},timestamp:timestamps,indicators:{quote:[{open:[99,100,101],close:[100,100,103],volume:[100,0,120]}]}}]}};
  const daily = parseChart(payload,'2330.TW',{tradedOnly:true});
  assert.deepEqual(daily.bars.map(row=>row.t), [timestamps[0],timestamps[2]]);
  const t = timestamps[2], hourly = {bars:[{t,open:101,close:103}],eventDates:[]};
  const half = {bars:[{t,open:101,close:102},{t:t+1800,open:102,close:103}],eventDates:[]};
  const row = alignCashReturns(['2026-10-27'],daily,hourly,half)[0];
  assert.equal(row.previousDate,'2026-10-22'); assert.equal(row.previousClose,100);
  assert.ok(Math.abs(row.return0930-.02)<1e-12);
});

test('09:30 research can refresh in the morning but not before validation bars and publication buffer', () => {
  const cutoff = time => latestStudyDate(Date.parse(time),[TWSE_2026]);
  assert.equal(cutoff('2026-10-30T09:31:00+08:00'),'2026-10-29');
  assert.equal(cutoff('2026-10-30T10:29:59+08:00'),'2026-10-29');
  assert.equal(cutoff('2026-10-30T10:30:00+08:00'),'2026-10-30');
  assert.equal(cutoff('2026-10-31T11:00:00+08:00'),'2026-10-30');
  assert.equal(cutoff('2026-09-28T11:00:00+08:00'),'2026-09-24');
  assert.equal(cutoff('2027-01-04T11:00:00+08:00'),null);
  assert.equal(latestStudyDate(NaN,[TWSE_2026]),null);
});
