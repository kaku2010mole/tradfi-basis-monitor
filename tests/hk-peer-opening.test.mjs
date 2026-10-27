import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const common = stripTypeScriptTypes(await readFile(new URL('../app/lib/smicOpening.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../app/lib/hkPeerOpening.ts', import.meta.url), 'utf8')).replace(/^import .*from "\.\/smicOpening";\s*$/gm, '');
const model = await import('data:text/javascript;base64,' + Buffer.from(common + '\n' + source).toString('base64'));
const seeds = Object.fromEntries(await Promise.all(['zhongji', 'gigadev'].map(async asset => [asset, JSON.parse(await readFile(new URL(`../app/data/${asset}OpeningStudy.json`, import.meta.url), 'utf8'))])));

test('both models reproduce the independently calculated research coefficients and forward errors', () => {
  const z = model.peerStudy(seeds.zhongji.rows, '2026-10-28', 'zhongji');
  assert.equal(z.model.n, 58); assert.equal(z.backtest.n, 28); assert.equal(z.backtest.nonflat, 26);
  assert.ok(Math.abs(z.model.peerBeta - .370774) < .000002);
  assert.ok(Math.abs(z.model.smhBeta - .182099) < .000002);
  assert.ok(Math.abs(z.backtest.mae - 1.505408) < .000002);
  const g = model.peerStudy(seeds.gigadev.rows, '2026-10-28', 'gigadev');
  assert.equal(g.model.n, 183); assert.equal(g.backtest.n, 123); assert.equal(g.backtest.hits, 91); assert.equal(g.backtest.nonflat, 120);
  assert.ok(Math.abs(g.model.peerBeta - .3792714) < .000002);
  assert.ok(Math.abs(g.model.smhBeta - .4011734) < .000002);
  assert.ok(Math.abs(g.backtest.mae - 2.26883915) < .000002);
});
test('joint cohorts use both factors; marginal groups reconcile to the published MU chart', () => {
  const s = model.peerStudy(seeds.gigadev.rows, '2026-10-28', 'gigadev');
  assert.equal(s.groups.reduce((sum, g) => sum + g.n, 0), 183);
  assert.equal(s.peerGroups[5].n, 25); assert.equal(s.peerGroups[5].up, 24);
  assert.ok(Math.abs(s.peerGroups[5].mean - 4.289247926) < 1e-7);
  assert.deepEqual([-4.01, -4, -2, 0, 2, 4, NaN].map(model.peerGroupIndex), [0, 1, 2, 3, 4, 5, -1]);
  const a = model.peerEstimate(s.model, s.groups, 0, 0), b = model.peerEstimate(s.model, s.groups, 2, 0), c = model.peerEstimate(s.model, s.groups, 0, 3);
  assert.equal(a.group.index, 4); assert.equal(b.group.index, 7); assert.equal(c.group.index, 5);
  assert.ok(Math.abs(b.gap - a.gap - 2*s.model.smhBeta) < 1e-10);
  assert.ok(Math.abs(c.gap - a.gap - 3*s.model.peerBeta) < 1e-10);
  assert.equal(model.peerEstimate(s.model, s.groups, 0, null), null);
});
test('target and future gaps cannot alter their own historical predictions', () => {
  for (const asset of ['zhongji', 'gigadev']) {
    const rows = seeds[asset].rows, last = rows.at(-1), a = model.peerStudy(rows, '2026-10-28', asset);
    const altered = rows.map(row => row.date === last.date ? {...row, gap: 999} : row);
    const b = model.peerStudy(altered, '2026-10-28', asset);
    assert.equal(a.backtest.recent[0].predicted, b.backtest.recent[0].predicted);
    assert.notEqual(a.backtest.recent[0].actual, b.backtest.recent[0].actual);
    assert.equal(model.peerTraining([...rows, {...last, date:'2026-10-28', gap:999}], '2026-10-28').length, rows.length);
  }
});
test('IPO clipping excludes a reused ticker and requires the same completed US peer session', () => {
  const hk = [{date:'2026-07-29',open:5,close:5,complete:true},{date:'2026-07-30',open:100,close:100,complete:true},{date:'2026-07-31',open:110,close:110,complete:true}];
  const us = [{date:'2026-07-29',open:100,close:100,complete:true},{date:'2026-07-30',open:100,close:102,complete:true}];
  const peer = [{date:'2026-07-30',open:200,close:210,complete:true}];
  const rows = model.alignedPeerRows(hk, us, peer, Date.parse('2026-07-31T12:00:00+08:00'), 'zhongji');
  assert.equal(rows.length, 1); assert.equal(rows[0].date, '2026-07-31');
  assert.ok(Math.abs(rows[0].peerReturn - 5) < 1e-10);
  assert.equal(model.alignedPeerRows(hk, us, [{...peer[0],complete:false}], Date.parse('2026-07-31T12:00:00+08:00'), 'zhongji').length, 0);
});
