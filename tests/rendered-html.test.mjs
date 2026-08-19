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
  assert.match(html, /Hyperliquid Taker–Taker/);
  assert.doesNotMatch(html, /href="\/blog"/);
  assert.doesNotMatch(html, /href="\/trade"/);
});

test("discovers and normalizes Posley ADR streams for HK auction basis", async () => {
  const auction = await readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8");
  assert.match(auction, /\/api\/hk-auction\/adr-quotes/);
  assert.doesNotMatch(auction, /beginPosleyLogin/);
  assert.match(auction, /TCEHY/);
  assert.match(auction, /XIACY/);
  assert.match(auction, /KSHTY/);
  assert.match(auction, /MPNGY/);
  assert.match(auction, /PMRTY/);
  assert.match(auction, /MMXGY/);
  assert.match(auction, /SHORT \$\{pair\.adrSymbol\} \/ LONG FUTU/);
  assert.match(auction, /ADR_BENCHMARK_MAX_AGE_MS/);
});

test("keeps the Posley refresh token on the server", async () => {
  const [auction, proxy] = await Promise.all([
    readFile(new URL("../app/hk-auction/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/posleyAdr.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(auction, /POSLEY_REFRESH_TOKEN/);
  assert.match(proxy, /process\.env\.POSLEY_REFRESH_TOKEN/);
  assert.doesNotMatch(proxy, /refreshToken[^\n]*return/);
});

test("does not proxy the Posley stream directory without a Cognito token", async () => {
  const response = await render("/api/hk-auction/adr-streams");
  assert.equal(response.status, 401);
});

test("keeps live taker execution explicitly gated", async () => {
  const [studio, livePanel, auth] = await Promise.all([
    readFile(new URL("../app/taker/TakerStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/LiveDcaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/taker/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /PAPER \+ LIVE/);
  assert.match(studio, /now - lastQuoteAt < 5_000/);
  assert.match(livePanel, /Two IOC orders · one signed exchange action/);
  assert.match(livePanel, /I authorize two real Hyperliquid mainnet IOC orders per slice/);
  assert.ok(livePanel.includes("UNHEDGED ${filled.coin} FILL"));
  assert.match(livePanel, /tif: "Ioc"/);
  assert.match(livePanel, /orders: \[/);
  assert.doesNotMatch(livePanel, /Binance/);
  assert.match(auth, /verifyTradeToken/);
});
