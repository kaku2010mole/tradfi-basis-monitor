import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../app/lib/taiwanAdrStudy.ts", import.meta.url), "utf8");
const model = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));
const current = JSON.parse(await readFile(new URL("../app/data/taiwanAdrStudy.json", import.meta.url), "utf8"));
// Keep the original 57-date regression frozen while the current snapshot grows.
const sample = { ...current, dates:current.dates.slice(0,57), adrReturns:current.adrReturns.slice(0,57), returns0930:Object.fromEntries(Object.entries(current.returns0930).map(([code,values])=>[code,values.slice(0,57)])) };
const codes = ["2330", "2308", "3711", "2303", "2408", "2344", "2327", "2492"];

test("audited snapshot is aligned across 57 common dates, and cohort counts/hits match raw study", () => {
  assert.equal(sample.dates.length, 57);
  assert.equal(new Set(sample.dates).size, 57);
  assert.equal(sample.adrReturns.length, 57);
  for (const code of codes) { assert.equal(sample.returns0930[code].length, 57); assert.ok(sample.returns0930[code].every(Number.isFinite)); }
  for (const [direction, threshold, n, hits] of [
    ["up", .01, 18, [13,13,12,10,11,12,11,11]],
    ["down", .01, 18, [15,13,14,16,12,13,14,14]],
    ["up", .02, 9, [7,8,7,6,5,6,7,6]],
    ["down", .02, 11, [9,9,8,10,8,9,8,8]],
    ["either", .02, 20, [16,17,15,16,13,15,15,14]],
  ]) {
    const indices = model.adrCohort(sample, direction, threshold);
    assert.equal(indices.length, n);
    assert.deepEqual(codes.map(code => model.adrStudyStats(sample, code, indices).hits), hits);
  }
  assert.equal(model.adrCohort(sample, "either", .01).length, 36);
  const means = [1.4154822219896082,2.756053034618343,3.2716370076920027,3.023261805783586,2.4906796793722443,1.8701069346304666,3.3723555672578196,3.9409200828251354];
  codes.forEach((code, i) => assert.ok(Math.abs(model.adrStudyStats(sample, code, model.adrCohort(sample,"up",.02)).meanPct - means[i]) < 1e-10));
});

test("threshold equality, down/either direction, flats and losses are handled without cherry-picking", () => {
  const fixture = { dates: ["a","b","c","d","e"], adrReturns: [.01,-.02,.03,0,NaN], returns0930: { TEST: [.02,-.01,-.03,0,.5] } };
  assert.deepEqual(model.adrCohort(fixture,"up",.01),[0,2]);
  assert.deepEqual(model.adrCohort(fixture,"down",.02),[1]);
  assert.deepEqual(model.adrCohort(fixture,"either",.02),[1,2]);
  assert.deepEqual(model.adrCohort(fixture,null,.01),[]);
  const stats = model.adrStudyStats(fixture,"TEST",[0,1,2,3]);
  assert.equal(stats.hitPct,50);
  assert.equal(stats.flat,1);
  assert.ok(Math.abs(stats.meanPct + .5) < 1e-10);
  assert.equal(model.adrStudyStats(fixture,"MISSING",[0]).hitPct,null);
  assert.equal(model.matchingAdrDirection(null),null);
  assert.equal(model.matchingAdrDirection(0),null);
  assert.equal(model.matchesAdrThreshold(2,"up",2),true);
  assert.equal(model.matchesAdrThreshold(-2,"up",2),false);
  assert.equal(model.matchesAdrThreshold(-2,"down",2),true);
});

test("ADR return refuses missing, future or excessively old inputs rather than treating them as zero", () => {
  const target = Date.parse("2026-10-19T14:00:00+08:00"), cutoff = Date.parse("2026-10-20T09:00:00+08:00");
  const anchor = { price: 200, timestamp: target }, current = { price: 204, timestamp: cutoff };
  assert.ok(Math.abs(model.adrReturn(anchor,current,target,cutoff)-2)<1e-10);
  for (const bad of [null,{...current,timestamp:cutoff+1},{...current,price:0},{...current,timestamp:target-1}]) assert.equal(model.adrReturn(anchor,bad,target,cutoff),null);
  assert.equal(model.adrReturn({...anchor,timestamp:target+1},current,target,cutoff),null);
  assert.equal(model.adrReturn(anchor,current,target,cutoff+5*86400000),null);
});
