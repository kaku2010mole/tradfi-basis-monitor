import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const load = async file => {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));
};
const { TAIWAN_ADR_PAIRS, taiwanAdrPremium, taiwanUmcAdrPremium } = await load("../app/lib/taiwanStockBasis.ts");
const { mergeTaiwanFeed } = await load("../app/lib/taiwanFeedState.ts");
const now = Date.parse("2026-11-09T14:20:00+08:00");
const book = (bid, ask, index, timestamp = now) => ({ bid, ask, last: 999, index, timestamp });
const pairs = Object.fromEntries(TAIWAN_ADR_PAIRS.map(pair => [pair.symbol, pair]));
const asx = book(33.55, 33.58, 33.52);
const twasx = book(16.962, 16.984, 16.960);

function approximately(actual, expected) {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`);
}

test("ADR premium uses the verified share ratio and the correct executable price for each leg", () => {
  assert.deepEqual(Object.fromEntries(Object.values(pairs).map(({ symbol, taiwanSymbol, ratio, code }) =>
    [symbol, [taiwanSymbol, ratio, code]])), {
    ASXUSDT: ["TWASXUSDT", 2, "3711"],
    UMCUSDT: ["TWUMCUSDT", 5, "2303"],
    TSMUSDT: ["TWTSMUSDT", 5, "2330"],
  });

  for (const [symbol, adr, tw, ratio] of [
    ["ASXUSDT", asx, twasx, 2],
    ["TSMUSDT", book(382.58, 382.63, 382.65), book(68.84, 69.03, 68.71), 5],
  ]) {
    const result = taiwanAdrPremium(pairs[symbol], adr, tw, now);
    assert.equal(result.status, "live");
    assert.equal(result.timestamp, now);
    approximately(result.midpoint, 100 * ((adr.bid + adr.ask) / (ratio * (tw.bid + tw.ask)) - 1));
    approximately(result.buyAdr, 100 * (adr.ask / (ratio * tw.bid) - 1));
    approximately(result.sellAdr, 100 * (adr.bid / (ratio * tw.ask) - 1));
    approximately(result.index, 100 * (adr.index / (ratio * tw.index) - 1));
  }

  const withoutIndex = taiwanAdrPremium(pairs.ASXUSDT, { ...asx, index: null }, twasx, now);
  assert.equal(withoutIndex.status, "live");
  assert.equal(withoutIndex.index, null);
});

test("a missing ADR contract is distinct from quotes still loading or an invalid BBO", () => {
  const umc = pairs.UMCUSDT;
  const twumc = book(2.94, 2.95, 2.95);
  for (const [adr, tw, status] of [
    [null, twumc, "missing-adr"],
    [undefined, twumc, "waiting"],
    [book(14.8, 14.7, 14.7), twumc, "waiting"],
    [book(14.7, 14.8, 14.7), { ...twumc, bid: null }, "waiting"],
  ]) {
    const result = taiwanAdrPremium(umc, adr, tw, now);
    assert.equal(result.status, status);
    assert.equal(result.midpoint, null);
    assert.equal(result.buyAdr, null);
    assert.equal(result.sellAdr, null);
  }
});

test("both quotes must be fresh and their original timestamps must be close", () => {
  const pair = pairs.ASXUSDT;
  for (const [adrTimestamp, twTimestamp, status] of [
    [now - 15_000, now - 15_000, "live"],
    [now - 15_001, now - 14_999, "stale"],
    [now - 5_000, now, "live"],
    [now - 5_001, now, "unsynced"],
  ]) {
    const result = taiwanAdrPremium(pair, { ...asx, timestamp: adrTimestamp }, { ...twasx, timestamp: twTimestamp }, now);
    assert.equal(result.status, status);
    if (status !== "live") {
      assert.equal(result.midpoint, null);
      assert.equal(result.buyAdr, null);
      assert.equal(result.sellAdr, null);
    }
  }
});

test("a delayed UMC ADR reference can be compared with a fresh TWUMC midpoint", () => {
  const reference = { price: 14.39, timestamp: now - 30 * 60_000, source: "UMC reference" };
  const tw = book(2.900, 2.906, 2.902);
  const result = taiwanUmcAdrPremium(reference, tw, now);
  approximately(result.premium, 100 * (14.39 / (5 * 2.903) - 1));
  assert.equal(result.timestamp, reference.timestamp);
  assert.equal(taiwanUmcAdrPremium(reference, { ...tw, timestamp: now - 15_001 }, now).premium, null);
  assert.equal(taiwanUmcAdrPremium({ ...reference, timestamp: now + 1 }, tw, now).premium, null);
});

test("partial or older ADR feed responses retain original clocks, and explicit absence clears a retained book", () => {
  const oldAsx = { ...asx, timestamp: now - 2_000 };
  const oldUmc = book(14.7, 14.8, 14.7, now - 1_000);
  const oldTsm = book(382.58, 382.63, 382.65, now - 2_000);
  const prior = { rows: [], adrPerpBooks: { ASXUSDT: oldAsx, UMCUSDT: oldUmc, TSMUSDT: oldTsm } };
  assert.deepEqual(mergeTaiwanFeed(prior, { rows: [] }).adrPerpBooks, prior.adrPerpBooks);

  const freshTsm = book(382.65, 382.69, 382.67);
  const next = { rows: [], adrPerpBooks: {
    ASXUSDT: { ...asx, timestamp: now - 3_000 }, UMCUSDT: null, TSMUSDT: freshTsm,
  } };
  const updated = mergeTaiwanFeed(prior, next);
  assert.deepEqual(updated.adrPerpBooks, { ASXUSDT: oldAsx, UMCUSDT: null, TSMUSDT: freshTsm });
  assert.equal(mergeTaiwanFeed(updated, { rows: [], adrPerpBooks: { TSMUSDT: freshTsm } }).adrPerpBooks.UMCUSDT, null);
});
