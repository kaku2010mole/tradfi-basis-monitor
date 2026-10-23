import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64');
const equityUrl = moduleUrl(await readFile(new URL('../app/lib/equityBasis.ts', import.meta.url), 'utf8'));
const { impliedAdrBook, equitySpreads } = await import(equityUrl);
const mappings = [
  ['5802', 'SUMIELECUSDT', 'SMTOY', 0.5],
  ['6857', 'ADVANTESTUSDT', 'ATEYY', 1],
  ['6920', 'LASERTECUSDT', 'LSRCY', 0.2],
  ['8035', 'TOKYOELUSDT', 'TELWY', 0.5],
];

test('four Japanese ADR mappings survive closed cash/absent ADR feeds without adding subscriptions', async () => {
  const source = await readFile(new URL('../app/api/oracle-monitor/korean-bitget/route.ts', import.meta.url), 'utf8');
  const tickers = mappings.map(([, symbol]) => ({ symbol, bidPr: '100', askPr: '102', ts: '1792839600000' }));
  // Execute the real handler with isolated public-market clients. No sockets,
  // external requests, credentials, or new relay subscriptions are involved.
  const isolated = `import { equityBasis, equitySpreads, preferCashLast } from '${equityUrl}';
    const posleyAdrSnapshot = async () => { throw new Error('Unexpected new subscription'); };
    const bitgetBooksWithin = async () => ${JSON.stringify(tickers)};
    const publicBinanceJson = async () => [];
    const koreanLatestClose = () => null;
    ${source.replace(/^import .*;\n/gm, '')}
    export { ADR_SYMBOLS };`;
  const { GET, ADR_SYMBOLS } = await import(moduleUrl(isolated));
  assert.deepEqual(ADR_SYMBOLS, ['SONY', 'TM', 'MUFG']);
  const originalNow = Date.now, originalPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  const stamp = Date.parse('2026-10-24T03:00:00Z'); // Saturday; all cash markets closed.
  Date.now = () => stamp;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = { receivedAt: stamp, payload: { quotes: [
    { symbol: 'FX.USDKRW', bid: 1300, ask: 1301, marketTimestamp: stamp },
  ] } };
  try {
    const response = await GET(new Request('http://localhost/api/oracle-monitor/korean-bitget'));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    for (const [code, symbol, adrSymbol, sharesPerAdr] of mappings) {
      const row = data.rows.find(row => row.code === code);
      assert.equal(row.session, 'CLOSED');
      assert.equal(row.cashLast, null);
      assert.equal(row.adr.symbol, adrSymbol);
      assert.equal(row.adr.sharesPerAdr, sharesPerAdr);
      assert.match(row.adr.ratioSourceUrl, /^https:\/\//);
      assert.equal(row.adr.ratioVerifiedOn, '2026-10-23');
      for (const field of ['bid', 'ask', 'last', 'updatedAt']) assert.equal(row.adr[field], null);
      assert.equal(row.adr.source, 'No live ADR feed');
      assert.equal(row.venues[0].symbol, symbol);
      assert.equal(row.venues[0].sharesPerPerp, 1);
      assert.deepEqual(impliedAdrBook(row.venues[0], 1, sharesPerAdr), { bid: 100 * sharesPerAdr, ask: 102 * sharesPerAdr });
      assert.deepEqual(equitySpreads(null, null, row.venues[0]), { buyKoreaSellPerp: null, buyPerpSellKorea: null }, 'conversion must not invent an ADR spread');
      assert.ok(!data.posley.missing.includes(adrSymbol), 'no missing-feed alert for conversion-only ADR');
    }
  } finally {
    Date.now = originalNow;
    if (originalPush === undefined) delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    else globalThis.__FUTU_PUSH_SNAPSHOT__ = originalPush;
  }
});

test('ADR unit conversion retains missing sides and rejects invalid ratios without using last trades', () => {
  for (const [, , , ratio] of mappings) {
    assert.deepEqual(impliedAdrBook({ bid: null, ask: 100, last: 99 }, 1, ratio), { bid: null, ask: 100 * ratio });
    assert.deepEqual(impliedAdrBook({ last: 100 }, 1, ratio), { bid: null, ask: null });
    assert.deepEqual(impliedAdrBook({ bid: 100, ask: 102 }, 0, ratio), { bid: null, ask: null });
  }
});

test('folded ADR cards show only labeled bid/ask while details retain freshness and ratio sources', async () => {
  const component = await readFile(new URL('../app/components/KoreanPerpMonitor.tsx', import.meta.url), 'utf8');
  const summary = component.slice(component.indexOf('<summary className={styles.assetSummary}>'), component.indexOf('</summary>'));
  const css = await readFile(new URL('../app/components/KoreanPerpMonitor.module.css', import.meta.url), 'utf8');
  assert.match(summary, /IMPLIED BID \/ ASK \(USD\)/);
  assert.match(summary, /fmt\(impliedHeadline\?\.bid \?\? null, 3\)/);
  assert.match(summary, /fmt\(impliedHeadline\?\.ask \?\? null, 3\)/);
  assert.match(summary, /adrHeadline && <em>\{adrHeadline\.direction\}<\/em>/, 'live ADR edge/direction remains unchanged');
  assert.doesNotMatch(summary, /Implied ADR price|fresh perp|stale \/ missing perp|no ADR spread|impliedMid/);
  assert.match(css, /\.summarySignals>\.impliedAdrSignal\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(component, /Implied ADR price · USD/);
  assert.match(component, /not an ADR market quote/);
  assert.match(component, /Stale \/ missing perp/);
  assert.match(component, /href=\{adr\.ratioSourceUrl\}/);
  assert.match(component, /Ratio checked \{adr\.ratioVerifiedOn\}/);
  assert.match(component, /const POLL_MS = 2_000/);
});
