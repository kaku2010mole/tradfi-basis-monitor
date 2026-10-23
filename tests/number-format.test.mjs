import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(await readFile(new URL('../app/lib/numberFormat.ts', import.meta.url), 'utf8'));
const freshModule = tag => import('data:text/javascript;base64,' + Buffer.from(source + `\n// ${tag}`).toString('base64'));

test('cached number formatting preserves existing precision, rounding and every new price', async () => {
  const { decimalNumber } = await freshModule('equivalence');
  for (const [max, min] of [[0, 0], [2, 0], [3, 0], [3, 2], [3, 3], [4, 2], [6, 2], [7, 2]]) {
    for (const value of [0, -0, 0.000001, -0.000001, 1.23456789, -1.23456789, 59068.175, 59227.210, 61600, 1e12, Infinity, -Infinity, NaN]) {
      assert.equal(decimalNumber(value, max, min), value.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max }));
    }
  }
  assert.equal(decimalNumber(59068.175, 0), '59,068');
  assert.equal(decimalNumber(59068.875, 0), '59,069');
  assert.equal(decimalNumber(6.123456, 3, 3), '6.123'); // hedge ratios keep their precision
});

test('formatters are reused, cache is bounded and invalid precision never poisons it', async () => {
  const Original = Intl.NumberFormat;
  let created = 0;
  Intl.NumberFormat = new Proxy(Original, { construct(target, args) { created++; return Reflect.construct(target, args); } });
  try {
    const { decimalNumber } = await freshModule('bounded-cache');
    for (let i = 0; i < 1000; i++) decimalNumber(i + 0.123, 3, 3);
    assert.equal(created, 1);
    for (let max = 0; max <= 7; max++) for (let min = 0; min <= max; min++) decimalNumber(1, max, min);
    const full = created;
    decimalNumber(2, 7, 7); assert.equal(created, full);
    decimalNumber(2, 0, 0); assert.equal(created, full + 1); // oldest combination evicted (32-entry limit)
    assert.throws(() => decimalNumber(1, 2, 3), RangeError);
    assert.equal(decimalNumber(2, 7, 7), '2.0000000');
  } finally { Intl.NumberFormat = Original; }
});

test('green spread threshold is 0.5% with 1% amber and refresh cadence unchanged', async () => {
  const monitor = await readFile(new URL('../app/components/KoreanPerpMonitor.tsx', import.meta.url), 'utf8');
  const expression = monitor.match(/const spreadTone = [\s\S]+?=>\s*([^;]+);/)[1];
  const tone = new Function('value', `return ${expression}`);
  for (const v of [null, undefined, -2, 0, 0.3, 0.499]) assert.equal(tone(v), 'quiet');
  for (const v of [0.5, 0.75, 0.999]) assert.equal(tone(v), 'medium');
  for (const v of [1, 2]) assert.equal(tone(v), 'high');
  assert.match(monitor, /≥0\.5% teal/);
  assert.match(monitor, /const POLL_MS = 2_000/);
  const taiwan = await readFile(new URL('../app/components/TaiwanStockPanel.tsx', import.meta.url), 'utf8');
  assert.equal((taiwan.match(/magnitude >= 0\.5/g) ?? []).length, 2);
  assert.doesNotMatch(taiwan, /magnitude >= 0\.3/);
});
