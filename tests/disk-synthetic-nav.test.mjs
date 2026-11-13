import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const asModule = (source) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
const model = await import(asModule(await readFile(new URL("../app/lib/diskSyntheticNav.ts", import.meta.url), "utf8")));
const fixture = JSON.parse(await readFile(new URL("./fixtures/disk-synthetic-nav-regression.json", import.meta.url), "utf8"));
const sample = () => structuredClone(fixture.input);
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("the saved 17-stock cash-NAV-level regression reproduces 25.09 without a DRAM quote", () => {
  const input = sample();
  const result = model.calculateDiskSyntheticNav(input);
  assert.equal(result.status, "ready", result.reasons.join("; "));
  near(result.nav, 25.08691242442932);
  assert.equal(result.nav.toFixed(2), "25.09");
  assert.equal(result.rows.length, 17);
  near(result.coverage.total, .9999);
  near(result.coverage.perp, .8814);
  near(result.coverage.cash, .1106);
  near(result.coverage.cashBalance, .0079);
  assert.ok(input.rows.some((r) => r.currency === "CNY" && input.base.at - r.baseFxAt === 60 * 60_000), "NAV-date FX may be 60 minutes earlier than the US close");
});

test("Asian NAV cash levels retain the repricing already embedded in US-close perpetuals", () => {
  const input = sample();
  const correct = model.calculateDiskSyntheticNav(input);
  const hynix = input.rows.find((r) => r.symbol === "000660.KS");
  const kioxia = input.rows.find((r) => r.symbol === "285A.T");
  // These were the same perpetuals' US-close prices, rather than their old
  // daytime cash NAV marks. Using them as denominators omits earlier repricing.
  hynix.baseUsd = 905.05;
  hynix.baseNative = hynix.baseUsd * hynix.baseFxPrice;
  kioxia.baseUsd = 58;
  kioxia.baseNative = kioxia.baseUsd * kioxia.baseFxPrice;
  const wronglyRebased = model.calculateDiskSyntheticNav(input);
  assert.equal(wronglyRebased.status, "ready");
  assert.ok(correct.nav - wronglyRebased.nav > .62);
  near(correct.rows.find((r) => r.symbol === "000660.KS").grossRatio, 954.36 / (1136000 / 1340.3499755859375));
});

test("published weight rounding is normalized, while raw coverage is preserved", () => {
  const input = sample();
  const result = model.calculateDiskSyntheticNav(input);
  const rawWeightedValue = input.cashBalanceWeight + input.rows.reduce((sum, r) => sum + r.weight * r.currentUsd / r.baseUsd, 0);
  near(result.nav, input.base.nav * rawWeightedValue / .9999);
  assert.ok(Math.abs(result.nav - input.base.nav * rawWeightedValue) > .002);
  const missingHolding = { ...input, rows: input.rows.filter((r) => r.symbol !== "000660.KS") };
  assert.equal(model.calculateDiskSyntheticNav(missingHolding).nav, null);
});

test("a buy at the ask has positive discount below NAV, smaller than the bid discount", () => {
  const { nav } = model.calculateDiskSyntheticNav(sample());
  near(model.diskSyntheticNavDiscount(24.71, nav), 1.50242651647432);
  assert.ok(model.diskSyntheticNavDiscount(24.68, nav) > model.diskSyntheticNavDiscount(24.71, nav));
  assert.ok(model.diskSyntheticNavDiscount(26, nav) < 0);
  for (const invalid of [null, undefined, NaN, Infinity, 0, -1]) {
    assert.equal(model.diskSyntheticNavDiscount(invalid, nav), null);
    assert.equal(model.diskSyntheticNavDiscount(24.71, invalid), null);
  }
});

test("missing, invalid, duplicate or unconverted holdings never become zero-return fills", () => {
  const changes = [
    (r) => { r.currentUsd = null; },
    (r) => { r.baseUsd = 0; },
    (r) => { r.baseUsd = NaN; },
    (r) => { r.baseFxPrice = null; },
    (r) => { r.baseNative = r.baseNative * 2; },
    (r) => { r.weight = -r.weight; },
    (r) => { r.source = null; },
    (r) => { r.reason = "No validated matching price"; },
  ];
  for (const change of changes) {
    const input = sample();
    change(input.rows[0]);
    const result = model.calculateDiskSyntheticNav(input);
    assert.equal(result.nav, null);
    assert.equal(result.status, "partial");
    assert.ok(result.reasons.length);
  }
  const duplicate = sample();
  duplicate.rows[1].symbol = duplicate.rows[0].symbol;
  assert.equal(model.calculateDiskSyntheticNav(duplicate).nav, null);
  assert.equal(model.calculateDiskSyntheticNav({ ...sample(), cashBalanceWeight: -1 }).nav, null);
  assert.equal(model.calculateDiskSyntheticNav({ ...sample(), rows: [] }).status, "unavailable");
});

test("perpetual, cash, FX and calculation clocks are gated independently", () => {
  const input = sample();
  const future = input.now + 5_001;
  const mutations = [
    (x) => { x.rows[0].quoteAt = x.now - 45_001; },
    (x) => { x.rows[0].quoteAt = future; },
    (x) => { x.rows[0].baseAt = x.base.at + 5_001; },
    (x) => { x.rows[0].baseFxAt = x.base.at + 5_001; },
    (x) => { x.rows[0].baseFxAt = x.base.at - 90 * 60_000 - 1; },
    (x) => { x.calculatedAt = x.now - 120_001; },
    (x) => { x.calculatedAt = future; },
    (x) => { const r = x.rows.find((r) => r.sourceKind === "cash"); r.fxAt = future; },
    (x) => { const r = x.rows.find((r) => r.sourceKind === "cash"); r.fxAt = x.now - 35 * 60_000 - 1; },
  ];
  for (const mutate of mutations) {
    const changed = sample();
    mutate(changed);
    assert.equal(model.calculateDiskSyntheticNav(changed).nav, null);
  }
  const withinWindow = sample();
  withinWindow.rows[0].quoteAt = withinWindow.now - 45_000;
  assert.equal(model.calculateDiskSyntheticNav(withinWindow).status, "ready");
});

test("the completed CNY session close can anchor NAV without weakening live-quote or other FX freshness", () => {
  const input = sample();
  for (const row of input.rows.filter(row => row.currency === "CNY")) row.baseFxAt = input.base.at - 125 * 60_000;
  const closed = model.calculateDiskSyntheticNav(input);
  assert.equal(closed.status, "ready", closed.reasons.join("; "));
  near(closed.nav, model.calculateDiskSyntheticNav(sample()).nav);
  assert.ok(closed.rows.filter(row => row.currency === "CNY").every(row => row.baseFxAt === input.base.at - 125 * 60_000),
    "historical close references keep their real provider timestamps");
  const outsideClosingWindow = structuredClone(input);
  outsideClosingWindow.rows.find(row => row.currency === "CNY").baseFxAt = input.base.at - 145 * 60_000;
  assert.equal(model.calculateDiskSyntheticNav(outsideClosingWindow).nav, null);
  const otherCurrency = structuredClone(input);
  otherCurrency.rows.find(row => row.currency === "JPY").baseFxAt = input.base.at - 125 * 60_000;
  assert.equal(model.calculateDiskSyntheticNav(otherCurrency).nav, null);
  const stalePerp = structuredClone(input);
  const perp = stalePerp.rows.find(row => row.currency === "CNY" && row.sourceKind === "perp");
  perp.quoteAt = input.now - 45_001;
  assert.equal(model.calculateDiskSyntheticNav(stalePerp).nav, null);
  const staleLiveFx = structuredClone(input);
  staleLiveFx.rows.find(row => row.currency === "CNY" && row.sourceKind === "cash").fxAt = input.now - 35 * 60_000 - 1;
  assert.equal(model.calculateDiskSyntheticNav(staleLiveFx).nav, null);
  const staleBase = structuredClone(input);
  staleBase.base.at = staleBase.now - 7 * 86_400_000 - 1;
  assert.equal(model.calculateDiskSyntheticNav(staleBase).nav, null);
});

test("the CNY overnight close exception is bounded by currency, session time and the prior trading weekday", () => {
  const at = value => Date.parse(value);
  const close = at("2026-11-12T05:00:00+08:00");
  const quote = at("2026-11-12T02:55:00+08:00");
  assert.ok(model.navDateFxReference("CNY", quote, close));
  assert.equal(model.validNavDateFxTime("CNY", quote, close), true);
  assert.ok(model.navDateFxReference("CNY", at("2026-11-12T02:45:00+08:00"), close));
  assert.ok(model.navDateFxReference("CNY", at("2026-11-12T03:00:00+08:00"), close));
  for (const [currency, quoteAt, navAt] of [
    ["JPY", quote, close],
    ["CNY", at("2026-11-12T02:44:59+08:00"), close],
    ["CNY", at("2026-11-12T03:00:01+08:00"), close],
    ["CNY", quote, at("2026-11-12T06:00:00+08:00")],
    ["CNY", at("2026-11-11T02:55:00+08:00"), close],
    ["CNY", at("2026-11-16T02:55:00+08:00"), at("2026-11-16T05:00:00+08:00")],
  ]) {
    assert.equal(model.navDateFxReference(currency, quoteAt, navAt), null);
    assert.equal(model.validNavDateFxTime(currency, quoteAt, navAt), false);
  }
  assert.equal(model.validNavDateFxTime("JPY", close - 90 * 60_000, close), true);
  assert.equal(model.validNavDateFxTime("JPY", close - 90 * 60_000 - 1, close), false);
});

test("verified closed cash references keep their actual times and cannot excuse stale FX or perps", () => {
  const input = sample();
  const closed = input.rows.find((r) => r.symbol === "2337.TW");
  assert.ok(input.now - closed.quoteAt > 35 * 60_000);
  assert.equal(closed.reference, "Local market closed · verified completed-session reference");
  const ready = model.calculateDiskSyntheticNav(input);
  assert.equal(ready.status, "ready");
  assert.equal(ready.rows.find((r) => r.symbol === closed.symbol).quoteAt, closed.quoteAt);
  assert.equal(ready.oldestQuoteAt, Math.min(...input.rows.map((r) => r.quoteAt)));
  closed.reference = "Last seen cash price";
  assert.equal(model.calculateDiskSyntheticNav(input).nav, null);
  closed.reference = "Local market closed · verified completed-session reference";
  closed.quoteAt = input.now + 5_001;
  assert.equal(model.calculateDiskSyntheticNav(input).nav, null);
  const fakePerpClosure = sample();
  fakePerpClosure.rows[0].reference = "Local market closed · verified completed-session reference";
  fakePerpClosure.rows[0].quoteAt = fakePerpClosure.now - 60_000;
  assert.equal(model.calculateDiskSyntheticNav(fakePerpClosure).nav, null);
});

test("the dated official NAV baseline must be valid, while absent inputs retain loading status", () => {
  for (const patch of [{ nav: 0 }, { nav: NaN }, { date: "2026-99-99" }, { holdingsAsOf: "2026-02-31" }, { source: "" }]) {
    const input = sample();
    Object.assign(input.base, patch);
    assert.equal(model.calculateDiskSyntheticNav(input).status, "unavailable");
  }
  const staleBase = sample();
  staleBase.base.at = staleBase.now - 8 * 86_400_000;
  assert.equal(model.calculateDiskSyntheticNav(staleBase).nav, null);
  assert.equal(model.calculateDiskSyntheticNav({ ...sample(), base: null, rows: [], calculatedAt: null }).status, "loading");
});
