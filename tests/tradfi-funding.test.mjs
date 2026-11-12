import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../app/lib/bitgetTradfiFunding.ts', import.meta.url), 'utf8');
const { parseTradfiInstruments, parseTradfiFunding, rankTradfiFunding, fundingSnapshotFresh, FUNDING_STALE_MS } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const now = Date.parse('2026-11-12T06:00:00Z');
const instrument = (symbol, patch = {}) => ({ symbol, fullName: symbol, isRwa: 'YES', status: 'online', type: 'perpetual', instrumentType: 'stock', ...patch });
const response = (data, requestTime = now) => ({ code: '00000', requestTime, data });
const funding = (symbol, rate, hours = '8', patch = {}) => ({ symbol, fundingRate: rate, fundingRateInterval: hours, nextUpdate: String(now + 2 * 3600_000), ...patch });
const parse = (instruments, rates) => parseTradfiFunding(parseTradfiInstruments(response(instruments)), response(rates), now, now);

test('coverage follows Bitget RWA and online perpetual status, including misclassified TradFi and pre-IPO names', () => {
  const rows = parseTradfiInstruments(response([
    instrument('LGENERGYUSDT', { fullName: ' LG Energy Solution ' }),
    instrument('JIOUSDT', { instrumentType: 'crypto', symbolType: 'crypto', fullName: 'Jio Platforms Ltd' }),
    instrument('GDXUSDT', { instrumentType: 'crypto', symbolType: 'stock' }),
    instrument('BTCUSDT', { isRwa: 'NO' }),
    instrument('BTCM27', { type: 'delivery' }),
    instrument('OFFLINEUSDT', { status: 'offline' }),
  ]));
  assert.deepEqual(rows.map(r => [r.symbol, r.asset]), [['LGENERGYUSDT', 'stock'], ['JIOUSDT', 'other'], ['GDXUSDT', 'stock']]);
  assert.equal(rows[0].name, 'LG Energy Solution');
  assert.throws(() => parseTradfiInstruments(response([])), /coverage/);
  assert.throws(() => parseTradfiInstruments({ code: '40000', data: [] }), /unavailable/);
});

test('ranks original rates and equal-duration rates separately with correct signed 4h conversion', () => {
  const snapshot = parse(['PURRUSDT', 'HYUNDAIUSDT', 'UNITREEUSDT', 'HANMIUSDT'].map(s => instrument(s)), [
    funding('PURRUSDT', '.002746'), funding('HYUNDAIUSDT', '.00153', '4'),
    funding('UNITREEUSDT', '-.004285', '4'), funding('HANMIUSDT', '-.002413'),
  ]);
  assert.equal(snapshot.rows[1].rate8h, .00306);
  assert.equal(snapshot.rows[2].rate8h, -.00857);
  assert.equal(rankTradfiFunding(snapshot.rows, 'settlement').highest[0].symbol, 'PURRUSDT');
  assert.equal(rankTradfiFunding(snapshot.rows, '8h').highest[0].symbol, 'HYUNDAIUSDT');
  assert.equal(rankTradfiFunding(snapshot.rows, '8h').lowest[0].symbol, 'UNITREEUSDT');
  assert.deepEqual(snapshot.rows.map(r => r.symbol), ['PURRUSDT', 'HYUNDAIUSDT', 'UNITREEUSDT', 'HANMIUSDT']);
});

test('zero is valid; blank or missing rates are not invented as zero; unknown periods are excluded only from normalized ranking', () => {
  const names = ['ZEROUSDT', 'BLANKUSDT', 'MISSINGUSDT', 'NOPERIODUSDT', 'NANUSDT'];
  const snapshot = parse(names.map(s => instrument(s)), [funding('ZEROUSDT', '0'), funding('BLANKUSDT', ''), funding('NOPERIODUSDT', '.001', ''), funding('NANUSDT', 'NaN')]);
  assert.equal(snapshot.universeCount, 5);
  assert.equal(snapshot.missingFundingCount, 1);
  assert.equal(snapshot.invalidFundingCount, 2);
  assert.equal(snapshot.rows[0].rate, 0);
  assert.equal(snapshot.rows[1].rate8h, null);
  assert.equal(rankTradfiFunding(snapshot.rows, 'settlement').count, 2);
  assert.equal(rankTradfiFunding(snapshot.rows, '8h').count, 1);
});

test('a snapshot cannot relabel old or future funding data as newly fetched', () => {
  const instruments = parseTradfiInstruments(response([instrument('LGUSDT')]));
  for (const time of [null, 0, now + 5001, now - FUNDING_STALE_MS - 1]) {
    assert.throws(() => parseTradfiFunding(instruments, response([funding('LGUSDT', '.001')], time), now, now), /outdated/);
  }
  const snapshot = parseTradfiFunding(instruments, response([funding('LGUSDT', '.001')], now - 1000), now, now);
  assert.equal(snapshot.timestamp, now - 1000);
  assert.equal(fundingSnapshotFresh(snapshot, now), true);
  assert.equal(fundingSnapshotFresh(snapshot, now + FUNDING_STALE_MS), false);
  assert.equal(fundingSnapshotFresh({ ...snapshot, stale: true }, now), false);
});

test('search and asset filters change the ranking universe and keep external names intact', () => {
  const snapshot = parse([instrument('LGUSDT', { fullName: 'LG Energy Solution' }), instrument('RAMUSDT', { instrumentType: 'etf' })], [funding('LGUSDT', '.005'), funding('RAMUSDT', '-.002')]);
  assert.equal(rankTradfiFunding(snapshot.rows, 'settlement', 'energy').highest[0].symbol, 'LGUSDT');
  assert.equal(rankTradfiFunding(snapshot.rows, 'settlement', '', 'etf').lowest[0].symbol, 'RAMUSDT');
  assert.equal(rankTradfiFunding(snapshot.rows, 'settlement', 'nothing').count, 0);
});

test('dividends are flagged separately and never silently added to the displayed rate', () => {
  const snapshot = parse([instrument('DIVUSDT'), instrument('NODIVUSDT')], [funding('DIVUSDT', '.001', '8', { cashDividend: '.25' }), funding('NODIVUSDT', '0', '8', { cashDividend: '' })]);
  assert.equal(snapshot.rows[0].cashDividend, .25);
  assert.equal(snapshot.rows[0].rate, .001);
  assert.equal(snapshot.rows[1].cashDividend, null);
});
