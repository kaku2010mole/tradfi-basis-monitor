import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const navUrl = moduleUrl(await readFile(new URL("../app/lib/diskSyntheticNav.ts", import.meta.url), "utf8"));
const nav = await import(navUrl);
const hedge = await import(moduleUrl((await readFile(new URL("../app/lib/diskConstituentHedge.ts", import.meta.url), "utf8"))
  .replace('"./diskSyntheticNav"', JSON.stringify(navUrl))));
const fixture = JSON.parse(await readFile(new URL("./fixtures/disk-synthetic-nav-regression.json", import.meta.url), "utf8"));
const sample = () => nav.calculateDiskSyntheticNav(structuredClone(fixture.input));
const plan = (units, snapshot = sample(), now = fixture.input.now) => hedge.calculateDiskConstituentHedge(units, snapshot, now);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("DISK constituent shorts match fixed raw-weight cash NAV exposures, not market-value allocation", () => {
  const result = plan(1000);
  assert.equal(result.status, "ready");
  assert.equal(result.rows.length, 12);
  near(result.mappedWeight, .8814);
  near(result.hedgedWeight, .8814);
  near(result.unmappedWeight, .1185);
  near(result.rows.find(r => r.symbol === "000660.KS").quantity, 4.901804846429694);
  near(result.rows.find(r => r.symbol === "285A.T").quantity, 57.647973846058974);
  near(result.rows.find(r => r.symbol === "SNDK").quantity, 4.019861399531981);
  assert.equal(result.rows.find(r => r.symbol === "STX").perpSymbol, "STXSTOCKUSDT");
  const skhy = sample().rows.find(r => r.symbol === "SKHY");
  near(result.rows.find(r => r.symbol === "SKHY").quantity, 1000 * sample().base.nav * skhy.weight / skhy.baseUsd);
});

test("quantity scales with DISK units and does not rebalance when current constituent prices change", () => {
  const before = plan(1000), doubled = plan(2000);
  const moved = sample();
  moved.nav *= 1.5;
  moved.rows.forEach(row => { row.currentUsd *= 1.5; });
  const repriced = plan(1000, moved);
  before.rows.forEach((row, i) => {
    near(doubled.rows[i].quantity, row.quantity * 2);
    near(repriced.rows[i].quantity, row.quantity);
    near(repriced.rows[i].notional, row.notional * 1.5);
  });
});

test("partial baskets retain raw sizes without scaling mapped weights up to 100 percent", () => {
  const full = plan(1000), partial = sample();
  partial.rows = partial.rows.filter(row => row.sourceKind === "perp" && row.symbol !== "000660.KS");
  partial.status = "partial"; partial.nav = null;
  const result = plan(1000, partial);
  assert.equal(result.status, "ready", "missing cash stocks do not block mapped constituent targets");
  near(result.mappedWeight, .8814 - .1779);
  result.rows.forEach(row => near(row.quantity, full.rows.find(r => r.symbol === row.symbol).quantity));
});

test("empty or invalid quantities do not invent positions, while a zero holding gives zero targets", () => {
  const empty = plan(null);
  assert.equal(empty.status, "empty");
  near(empty.mappedWeight, .8814);
  assert.ok(empty.rows.every(row => row.quantity === null));
  for (const units of [-1, NaN, Infinity]) {
    const result = plan(units);
    assert.equal(result.status, "unavailable");
    assert.ok(result.rows.every(row => row.quantity === null));
  }
  const zero = plan(0);
  assert.equal(zero.status, "ready");
  assert.ok(zero.rows.every(row => row.quantity === 0 && row.notional === 0));
});

test("missing, inconsistent or duplicate baselines affect only their own mapped targets", () => {
  for (const change of [
    row => { row.baseUsd = null; }, row => { row.baseNative *= 2; },
    row => { row.baseAt = fixture.input.base.at + 5001; },
    row => { row.baseFxAt = fixture.input.base.at - 91 * 60000; },
  ]) {
    const snapshot = sample(); change(snapshot.rows[0]);
    const result = plan(1000, snapshot);
    assert.equal(result.status, "partial");
    assert.equal(result.rows[0].quantity, null);
    assert.ok(result.rows.slice(1).every(row => row.quantity > 0));
  }
  const duplicate = sample(); duplicate.rows[1].perpSymbol = duplicate.rows[0].perpSymbol;
  const result = plan(1000, duplicate);
  assert.equal(result.status, "partial");
  assert.equal(result.rows[0].quantity, null); assert.equal(result.rows[1].quantity, null);
});

test("expired current quotes hide notionals without changing valid dated hedge quantities", () => {
  const snapshot = sample();
  const initial = plan(1000, snapshot);
  snapshot.calculatedAt = fixture.input.now - 121000;
  const stale = plan(1000, snapshot);
  assert.equal(stale.status, "ready");
  stale.rows.forEach((row, i) => { near(row.quantity, initial.rows[i].quantity); assert.equal(row.notional, null); });
  assert.equal(stale.notional, null);
  const expired = plan(1000, sample(), fixture.input.now + 8 * 86400000);
  assert.equal(expired.status, "unavailable");
  assert.ok(expired.rows.every(row => row.quantity === null));
  const noSource = sample(); noSource.base.source = "";
  assert.equal(plan(1000, noSource).status, "unavailable");
  const noHoldings = sample(); noHoldings.base.holdingsSource = "";
  assert.equal(plan(1000, noHoldings).status, "unavailable");
});
