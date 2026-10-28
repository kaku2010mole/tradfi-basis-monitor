import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { alignCashReturns, parseChart } from '../scripts/extend-taiwan-adr-study.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const sample = JSON.parse(await read('../app/data/taiwanAdrStudy.json'));
const audit = JSON.parse(await read('./fixtures/taiwan-adr-extension-audit.json'));
const model = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await read('../app/lib/taiwanAdrStudy.ts'))).toString('base64'));

test('Hon Hai and MediaTek have audited half-hour returns, not placeholders or daily/hourly proxies', () => {
  for (const code of ['2317', '2454']) {
    const rows = audit.stocks[code].rows;
    assert.deepEqual(rows.map(row => row.date), sample.dates);
    assert.equal(rows.length, 57);
    assert.deepEqual(sample.returns0930[code], rows.map(row => row.return0930));
    assert.deepEqual(model.adrStudyCoverage(sample, code), { n: 52, total: 57, start: '2026-07-31', end: '2026-10-19' });
    for (const [i, row] of rows.entries()) {
      if (i < 5) { assert.equal(row.excluded, 'missing_half_hour_bars'); assert.equal(row.return0930, null); continue; }
      assert.equal(row.excluded, undefined);
      assert.ok(row.previousDate < row.date);
      assert.equal(new Date(row.firstBar.t * 1000).toISOString(), `${row.date}T01:00:00.000Z`);
      assert.equal(row.secondBar.t - row.firstBar.t, 1800);
      assert.ok(Math.abs(row.firstBar.open / row.dailyOpen - 1) <= .0001);
      assert.ok(Math.abs(row.secondBar.close / row.hourlyClose - 1) <= .0001);
      assert.equal(row.return0930, row.firstBar.close / row.previousClose - 1);
      assert.ok(audit.stocks[code].sources.every(source => !source.eventDates.includes(row.date)));
    }
  }
});

test('both stocks support up/down/either 1%/2% with their own valid denominators', () => {
  for (const [direction, threshold, n, hits] of [
    ['up', .01, 18, [10, 12]], ['up', .02, 9, [5, 7]],
    ['down', .01, 14, [12, 12]], ['down', .02, 9, [8, 8]],
    ['either', .01, 32, [22, 24]], ['either', .02, 18, [13, 15]],
  ]) for (const [i, code] of ['2317', '2454'].entries()) {
    const indices = model.adrCohort(sample, direction, threshold);
    const stats = model.adrStudyStats(sample, code, indices);
    assert.equal(stats.n, n); assert.equal(stats.hits, hits[i]);
    assert.equal(stats.hitPct, hits[i] / n * 100);
    const valid = indices.map(i => audit.stocks[code].rows[i].return0930).filter(Number.isFinite);
    assert.equal(stats.meanPct, valid.reduce((a,b) => a+b, 0) / valid.length * 100);
  }
  const fixture = { dates: ['a','b','c'], adrReturns: [.02,.02,.02], returns0930: { X: [null,0,.01] } };
  const stats = model.adrStudyStats(fixture, 'X', [0,1,2]);
  assert.equal(stats.n, 2); assert.equal(stats.flat, 1); assert.equal(stats.meanPct, .5); assert.equal(stats.hitPct, 50);
  assert.equal(model.adrStudyCoverage(fixture, 'X').n, 2);
});

test('cash audit rejects missing bars, corporate actions, mismatches and wrong chart identities', () => {
  const date = '2026-10-19', t = Date.parse(`${date}T09:00:00+08:00`) / 1000;
  const daily = { bars: [{ t: t - 3*86400, open: 98, close: 100 }, { t, open: 101, close: 103 }], eventDates: [] };
  const hourly = { bars: [{ t, open: 101, close: 103 }], eventDates: [] };
  const half = { bars: [{ t, open: 101, close: 102 }, { t: t+1800, open: 102, close: 103 }], eventDates: [] };
  assert.ok(Math.abs(alignCashReturns([date], daily, hourly, half)[0].return0930 - .02) < 1e-12);
  for (const [change, reason] of [
    [{ ...half, bars: [] }, 'missing_half_hour_bars'],
    [{ ...half, eventDates: [date] }, 'cash_corporate_action'],
    [{ ...half, bars: [{...half.bars[0], open: 50}, half.bars[1]] }, 'half_hour_daily_open_mismatch'],
    [{ ...half, bars: [half.bars[0], {...half.bars[1], close: 104}] }, 'half_hour_hourly_10am_mismatch'],
  ]) { const row = alignCashReturns([date], daily, hourly, change)[0]; assert.equal(row.excluded, reason); assert.equal(row.return0930, null); }
  for (const [symbol, currency] of [['2454.TW','TWD'], ['2317.TW','USD']]) assert.throws(() => parseChart({chart:{result:[{meta:{symbol,currency}}]}}, '2317.TW'));
});

test('rendered historical table includes both new stocks, explicit partial coverage and valid stats', async () => {
  const bundle = await build({ entryPoints: [new URL('../app/components/TaiwanAdrOutlook.tsx', import.meta.url).pathname], bundle:true, write:false, platform:'node', format:'cjs', jsx:'automatic', external:['react','react/jsx-runtime'], plugins:[{name:'test-css',setup(b){b.onLoad({filter:/\.css$/},()=>({contents:'export default {};',loader:'js'}));}}], logLevel:'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.default, { tsm: {}, anchorTimestamp: null, now: Date.parse('2026-10-28T08:00:00+08:00') })).replaceAll(/<!--.*?-->/g, '');
  for (const text of ['Hon Hai Precision','MediaTek','2317','2454','52/57','2026-07-31','55.6%','66.7%','77.8%','+0.586%','+3.464%','10 Taiwan stocks','valid n per stock below','conditioned on TSM ADR']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('across all eight stocks'));
});
