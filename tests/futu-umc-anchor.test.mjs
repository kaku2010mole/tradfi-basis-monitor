import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const moduleUrl = (source) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
const { validFutuAdrAnchors, mergeFutuAdrAnchors } = await import(moduleUrl(await readFile(new URL("../app/lib/futuAdrAnchors.ts", import.meta.url), "utf8")));
const modelUrl = moduleUrl(await readFile(new URL("../app/lib/taiwanStockBasis.ts", import.meta.url), "utf8"));
const at = (date) => Date.parse(date + "+08:00");
const timestamp = at("2026-10-20T17:00:00");
const point = { price: 19.67, timestamp, volume: 0 };

test("Futu UMC anchors accept a zero-volume reference, never an invalid or future minute", () => {
  const now = timestamp + 60_000;
  assert.equal(validFutuAdrAnchors([point], now), true);
  for (const value of [null, {}, [], Array(41).fill(point), [{ ...point, price: 0 }], [{ ...point, volume: -1 }],
    [{ ...point, volume: 1.5 }], [{ ...point, price: "19.67" }], [{ ...point, timestamp: timestamp - 3_600_000 }],
    [{ ...point, timestamp: timestamp + 86_400_000 }], [{ ...point, timestamp: timestamp - 41 * 86_400_000 }]]) {
    assert.equal(validFutuAdrAnchors(value, now), false, JSON.stringify(value));
  }
  assert.equal(validFutuAdrAnchors([point], now - 1), false, "wait for final minute volume");
  assert.deepEqual(mergeFutuAdrAnchors([point], [], now), [point]);
  assert.deepEqual(mergeFutuAdrAnchors([point], [{ ...point, price: 19.68 }], now), [{ ...point, price: 19.68 }]);
});

test("UMC 17:00 Futu baseline is separate from latest ADR, retains provenance and rolls by date", async () => {
  const source = (await readFile(new URL("../app/lib/taiwanMarket.ts", import.meta.url), "utf8"))
    .replace('from "./taiwanStockBasis"', `from ${JSON.stringify(modelUrl)}`)
    .replace('import { bitgetBooks } from "./bitgetRelativeMarket";', "const bitgetBooks = async () => [];")
    .replace('import { taiwanCashSnapshot } from "./fugleTaiwanMarket";', "const taiwanCashSnapshot = async () => ({ quotes: {} });")
    .replace('import { taiwanLatestCloses } from "./taiwanLatestClose";', "const taiwanLatestCloses = () => ({});")
    .replace('import { taiwanFxSnapshot } from "./taiwanFxMarket";', "const taiwanFxSnapshot = async () => undefined;")
    .replace('import { honHaiGdrSnapshot } from "./honHaiGdrMarket";', "const honHaiGdrSnapshot = () => ({ quote: null, error: null });");
  const { taiwanSnapshot } = await import(moduleUrl(source));
  const originalFetch = globalThis.fetch, originalNow = Date.now, originalPush = globalThis.__FUTU_PUSH_SNAPSHOT__;
  let now = timestamp + 20 * 60_000, offline = false;
  Date.now = () => now;
  globalThis.__FUTU_PUSH_SNAPSHOT__ = { receivedAt: now, payload: { quotes: [], umcAdrAnchors: [point] } };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.host === "www.twse.com.tw") return new Response("", { status: 503 });
    if (url.pathname.endsWith("/history-index-candles")) {
      const target = Number(url.searchParams.get("startTime")) + 60_000;
      return Response.json({ code: "00000", data: [[target, "100"]] });
    }
    if (url.host === "query1.finance.yahoo.com") {
      if (offline) return new Response("", { status: 503 });
      const symbol = url.pathname.split("/").at(-1);
      return Response.json({ chart: { result: [{ meta: { symbol, currency: "USD" },
        timestamp: [timestamp / 1000, (timestamp + 15 * 60_000) / 1000],
        indicators: { quote: [{ open: [99, null], close: [19.66, 19.5] }] } }] } });
    }
    throw new Error("Unexpected request");
  };
  try {
    const first = await taiwanSnapshot(now);
    assert.equal(first.adrs.UMC.anchor.price, 19.67, "Futu wins over same-time Yahoo open");
    assert.equal(first.adrs.UMC.anchor.timestamp, timestamp);
    assert.equal(first.adrs.UMC.anchor.volume, 0);
    assert.match(first.adrs.UMC.anchor.source, /Futu.*indicative/);
    assert.equal(first.adrs.UMC.anchorMode, "17:00 fallback");
    assert.equal(first.adrs.UMC.current.price, 19.5, "baseline is not the latest ADR quote");
    assert.equal(first.adrs.UMC.openingAnchor, null);
    assert.equal(first.tsm.anchor.price, 99, "UMC source must not affect TSM");
    offline = true;
    now += 31_000;
    globalThis.__FUTU_PUSH_SNAPSHOT__.payload.umcAdrAnchors = [];
    const retained = await taiwanSnapshot(now);
    assert.equal(retained.adrs.UMC.anchor.price, 19.67);
    assert.equal(retained.adrs.UMC.current.timestamp, timestamp + 20 * 60_000, "no retimestamping through a network outage");
    now = at("2026-10-21T14:00:00");
    assert.equal((await taiwanSnapshot(now)).adrs.UMC.anchor, null, "yesterday cannot anchor today's model");
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    if (originalPush) globalThis.__FUTU_PUSH_SNAPSHOT__ = originalPush;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
});

test("authenticated anchor-only ingest merges without erasing live books or accepting malformed data", async () => {
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const prior = globalThis.__FUTU_PUSH_SNAPSHOT__, token = "test-futu-push-token";
  const now = Date.now(), day = 86_400_000;
  const anchor = { ...point, timestamp: Math.floor((now - 60_000 - 9 * 3_600_000) / day) * day + 9 * 3_600_000 };
  const send = (payload, auth = token) => worker.fetch(new Request("http://localhost/api/hk-auction/ingest", {
    method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ generatedAt: Date.now(), ...payload }),
  }), { FUTU_PUSH_TOKEN: token }, { waitUntil() {}, passThroughOnException() {} });
  try {
    delete globalThis.__FUTU_PUSH_SNAPSHOT__;
    assert.equal((await send({ quotes: [], umcAdrAnchors: [anchor] }, "wrong")).status, 401);
    assert.equal((await send({ quotes: [], umcAdrAnchors: [anchor] })).status, 202);
    assert.deepEqual(globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes, []);
    assert.equal((await send({ quotes: [{ symbol: "HK.09999", last: 180 }] })).status, 202);
    assert.deepEqual(globalThis.__FUTU_PUSH_SNAPSHOT__.payload.umcAdrAnchors, [anchor]);
    assert.equal((await send({ quotes: [], umcAdrAnchors: [anchor] })).status, 202);
    assert.equal(globalThis.__FUTU_PUSH_SNAPSHOT__.payload.quotes[0].symbol, "HK.09999");
    for (const anchors of [[], null, {}, [{ ...anchor, timestamp: anchor.timestamp + 1 }], [{ ...anchor, volume: -1 }]]) {
      assert.equal((await send({ quotes: [], umcAdrAnchors: anchors })).status, 400);
    }
    assert.equal((await send({ quotes: [] })).status, 400);
  } finally {
    if (prior) globalThis.__FUTU_PUSH_SNAPSHOT__ = prior;
    else delete globalThis.__FUTU_PUSH_SNAPSHOT__;
  }
});
