import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
const source=await readFile(new URL("../app/lib/smicOpening.ts",import.meta.url),"utf8");
const m=await import("data:text/javascript;base64,"+Buffer.from(stripTypeScriptTypes(source)).toString("base64"));
const seed=JSON.parse(await readFile(new URL("../app/data/smicOpeningStudy.json",import.meta.url),"utf8"));

test("recent-year single-factor calibration and historical groups reconcile to source observations",()=>{
  const rows=m.trainingRows(seed.rows,"2026-10-27"),fit=m.fitSmic(rows),groups=m.smicGroups(rows);
  assert.equal(rows.length,229);assert.equal(groups.reduce((n,g)=>n+g.n,0),229);
  assert.ok(fit.beta>.42 && fit.beta<.45);assert.ok(fit.r2>.31 && fit.r2<.34);
  assert.equal(groups[7].n,24);assert.equal(groups[7].up,22);
  assert.ok(Math.abs(groups[7].mean-2.241387510470833)<1e-7);
  groups.forEach(g=>{assert.equal(g.up+g.down+g.flat,g.n);assert.ok(Math.abs(g.upPct+g.downPct+g.flatPct-100)<1e-8);});
});
test("group endpoints, genuine flat days and unavailable inputs are distinct",()=>{
  assert.deepEqual([-3.01,-3,-2,-1,0,1,2,3,Infinity,NaN].map(m.smicGroupIndex),[0,1,2,3,4,5,6,7,-1,-1]);
  const model=m.fitSmic(m.trainingRows(seed.rows,"2026-10-27")),groups=m.smicGroups(seed.rows);
  assert.equal(m.smicEstimate(model,groups,null),null);assert.equal(m.smicEstimate(model,groups,NaN),null);
  assert.equal(m.smicEstimate(model,groups,0).gap,model.intercept);
  assert.equal(m.smicEstimate(null,groups,2),null);
});
test("rolling forecasts exclude the predicted day and all future observations",()=>{
  const a=m.smicBacktest(seed.rows,"2026-10-27");assert.equal(a.n,229);assert.equal(a.nonflat,218);
  const last=seed.rows.at(-1);const altered=seed.rows.map(r=>r.date===last.date?{...r,gap:r.gap+100}:r);
  const b=m.smicBacktest(altered,"2026-10-27");assert.equal(a.recent[0].predicted,b.recent[0].predicted);
  assert.notEqual(a.recent[0].actual,b.recent[0].actual);
  assert.equal(m.trainingRows([...seed.rows,{...last,date:"2026-10-27",gap:999}],"2026-10-27").length,229);
});
test("forecast target rolls at HK open and anchors do not reset at the US close",()=>{
  const w=m.nextSmicWindow(Date.parse("2026-10-27T11:00:00+08:00"));
  assert.equal(w.date,"2026-10-28");assert.equal(w.signalDate,"2026-10-27");assert.equal(w.anchorDate,"2026-10-26");
  const after=m.nextSmicWindow(Date.parse("2026-10-28T06:00:00+08:00"));assert.equal(after.anchorDate,"2026-10-26");
  const roll=m.nextSmicWindow(Date.parse("2026-10-28T09:30:00+08:00"));assert.equal(roll.date,"2026-10-29");assert.equal(roll.anchorDate,"2026-10-27");
  const mon=m.nextSmicWindow(Date.parse("2026-10-30T18:00:00+08:00"));assert.equal(mon.date,"2026-11-02");assert.equal(mon.signalDate,"2026-10-30");
});
test("HK holidays, no-US-session intervals, early closes, DST and unknown calendars are explicit",()=>{
  const holiday=m.nextSmicWindow(Date.parse("2026-10-16T18:00:00+08:00"));assert.equal(holiday.date,"2026-10-20");assert.equal(holiday.usDates.length,2);assert.ok(holiday.error);
  const usHoliday=m.nextSmicWindow(Date.parse("2026-09-07T12:00:00+08:00"));assert.equal(usHoliday.date,"2026-09-08");assert.equal(usHoliday.usDates.length,0);assert.ok(usHoliday.error);
  assert.equal(new Date(m.usOpen("2026-10-27")).toISOString(),"2026-10-27T13:30:00.000Z");
  assert.equal(new Date(m.usOpen("2026-11-02")).toISOString(),"2026-11-02T14:30:00.000Z");
  assert.equal(new Date(m.usClose("2026-11-27")).toISOString(),"2026-11-27T18:00:00.000Z");
  assert.equal(new Date(m.hkClose("2026-12-24")).toISOString(),"2026-12-24T04:10:00.000Z");
  assert.equal(m.nextSmicWindow(Date.parse("2028-01-04T00:00:00Z")),null);
});
test("daily alignment uses actual market windows and never tomorrow's price",()=>{
  const hk=[{date:"2026-10-23",open:47,close:46,complete:true},{date:"2026-10-26",open:47,close:45,complete:true},{date:"2026-10-27",open:46,close:44,complete:false}];
  const us=[{date:"2026-10-22",open:500,close:500,complete:true},{date:"2026-10-23",open:500,close:510,complete:true},{date:"2026-10-26",open:510,close:520,complete:true}];
  const rows=m.alignedSmicRows(hk,us,Date.parse("2026-10-27T11:00:00+08:00"));
  assert.equal(rows.length,2);assert.equal(rows[0].usDate,"2026-10-23");assert.equal(rows[1].usDate,"2026-10-26");
  assert.ok(Math.abs(rows[0].smhReturn-2)<1e-9);assert.equal(rows[1].previousClose,45);
  assert.equal(m.alignedSmicRows(hk,us,Date.parse("2026-10-27T08:00:00+08:00")).length,1);
});
