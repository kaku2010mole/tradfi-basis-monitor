import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const common=stripTypeScriptTypes(await readFile(new URL('../app/lib/smicOpening.ts',import.meta.url),'utf8'));
const source=stripTypeScriptTypes(await readFile(new URL('../app/lib/doosenerOpening.ts',import.meta.url),'utf8')).replace(/^import .*from "\.\/smicOpening";\s*$/gm,'');
const m=await import('data:text/javascript;base64,'+Buffer.from(common+'\n'+source).toString('base64'));
const seed=JSON.parse(await readFile(new URL('../app/data/doosenerOpeningStudy.json',import.meta.url),'utf8'));
test('two-factor calibration, joint groups and walk-forward predictions reconcile to the research sample',()=>{
  const study=m.doosenerStudy(seed.rows,'2026-10-28');
  assert.equal(study.model.n,227);assert.ok(Math.abs(study.model.ewyBeta-.3147)<.002);assert.ok(Math.abs(study.model.smhBeta-.452)<.002);
  assert.ok(study.model.r2>.39&&study.model.r2<.40);
  assert.equal(study.groups.reduce((s,g)=>s+g.n,0),227);assert.equal(study.groups[8].n,41);assert.equal(study.groups[8].up,37);
  assert.equal(study.groups.reduce((s,g)=>s+g.flat,0),7);assert.equal(study.smhGroups[7].n,23);assert.equal(study.ewyGroups[7].up,19);
  assert.equal(study.backtest.n,227);assert.equal(study.backtest.nonflat,220);assert.ok(Math.abs(study.backtest.mae-1.53435)<.001);
});
test('each live factor independently changes the estimate and the selected probability cohort',()=>{
  const s=m.doosenerStudy(seed.rows,'2026-10-28');
  const a=m.doosenerEstimate(s.model,s.groups,0,0),b=m.doosenerEstimate(s.model,s.groups,2,0),c=m.doosenerEstimate(s.model,s.groups,0,2);
  assert.ok(Math.abs(b.gap-a.gap-2*s.model.smhBeta)<1e-10);assert.ok(Math.abs(c.gap-a.gap-2*s.model.ewyBeta)<1e-10);
  assert.equal(a.group.index,4);assert.equal(b.group.index,7);assert.equal(c.group.index,5);
  assert.equal(m.doosenerEstimate(s.model,s.groups,0,null),null);assert.equal(m.doosenerEstimate(s.model,s.groups,NaN,0),null);
  assert.deepEqual([-1.001,-1,0,.999,1].map(m.jointIndex),[0,1,1,1,2]);
});
test('KRX target rolls at its own opening and preserves the associated US anchors',()=>{
  const before=m.nextDoosenerWindow(Date.parse('2026-10-28T07:59:59+08:00'));assert.equal(before.date,'2026-10-28');assert.equal(before.anchorDate,'2026-10-26');
  const after=m.nextDoosenerWindow(Date.parse('2026-10-28T08:00:00+08:00'));assert.equal(after.date,'2026-10-29');assert.equal(after.anchorDate,'2026-10-27');
  const afterUs=m.nextDoosenerWindow(Date.parse('2026-10-28T06:00:00+08:00'));assert.equal(afterUs.signalDate,'2026-10-27');assert.equal(afterUs.anchorDate,'2026-10-26');
  assert.equal(m.nextSmicWindow(Date.parse('2026-10-28T08:00:00+08:00')).date,'2026-10-28','Hong Kong has not opened yet');
  const monday=m.nextDoosenerWindow(Date.parse('2026-10-30T18:00:00+08:00'));assert.equal(monday.date,'2026-11-02');assert.equal(monday.signalDate,'2026-10-30');
});
test('Korean holidays and delayed openings cannot silently use the standard session',()=>{
  assert.equal(m.krTradingDay('2026-07-17'),false);assert.equal(m.krTradingDay('2026-10-09'),false);
  const multiple=m.nextDoosenerWindow(Date.parse('2026-10-08T18:00:00+08:00'));assert.equal(multiple.date,'2026-10-12');assert.equal(multiple.usDates.length,2);assert.ok(multiple.error);
  const none=m.nextDoosenerWindow(Date.parse('2026-09-07T12:00:00+08:00'));assert.equal(none.usDates.length,0);assert.ok(none.error);
  const late=m.nextDoosenerWindow(Date.parse('2026-11-19T08:30:00+08:00'));assert.equal(late.date,'2026-11-19');assert.equal(new Date(late.openAt).toISOString(),'2026-11-19T01:00:00.000Z');
  assert.equal(m.nextDoosenerWindow(Date.parse('2028-01-03T00:00:00Z')),null);
});
test('future target prices cannot leak into historical training or prior predictions',()=>{
  const a=m.doosenerStudy(seed.rows,'2026-10-28'),last=seed.rows.at(-1);
  const changed=seed.rows.map(r=>r.date===last.date?{...r,gap:r.gap+100}:r);
  const b=m.doosenerStudy(changed,'2026-10-28');assert.equal(a.backtest.recent[0].predicted,b.backtest.recent[0].predicted);assert.notEqual(a.backtest.recent[0].actual,b.backtest.recent[0].actual);
  assert.equal(m.doosenerTraining([...seed.rows,{...last,date:'2026-10-28',gap:999}],'2026-10-28').length,227);
});
