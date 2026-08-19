import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the TradFi dashboard shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TradFi Basis Monitor<\/title>/i);
  assert.match(html, /Set the anchor\. Then watch the drift\./);
  assert.match(html, /href="\/taker"/);
  assert.match(html, /Taker–Taker DCA/);
});

test("keeps live taker execution explicitly gated", async () => {
  const [studio, livePanel, auth] = await Promise.all([
    readFile(new URL("../app/taker/TakerStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/LiveDcaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /PAPER \+ LIVE/);
  assert.match(studio, /now - lastQuoteAt < 5_000/);
  assert.match(livePanel, /Hyperliquid IOC first · Binance market hedge second/);
  assert.match(livePanel, /I authorize real Hyperliquid and Binance mainnet orders/);
  assert.match(livePanel, /UNHEDGED HYPERLIQUID FILL/);
  assert.match(livePanel, /tif: "Ioc"/);
  assert.match(livePanel, /newOrderRespType: "RESULT"/);
  assert.match(auth, /verifyTradeToken/);
});
