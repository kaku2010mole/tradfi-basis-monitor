import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, createHash, createHmac } from "node:crypto";
import { createAuth, CLIENT, ISSUER } from "../services/posley-cloud/auth.mjs";
import { createFeed } from "../services/posley-cloud/feed.mjs";
import { decode, registry } from "../services/posley-cloud/registry.mjs";

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "posley-cloud-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "unit-test-key" };
  let now = Date.parse("2026-10-20T10:00:00Z"), nonce, invalid = false, requests = [];
  const jwt = () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: invalid ? "wrong-client" : CLIENT, token_use: "id",
      sub: "test", email: "test@posley.capital", email_verified: true, nonce, exp: now / 1000 + 3600 })).toString("base64url");
    return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.privateKey).toString("base64url")}`;
  };
  const fetcher = async (url, options) => {
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
    requests.push(new URLSearchParams(options.body));
    return Response.json({ id_token: jwt(), refresh_token: "test-only-renewal-credential-not-real" });
  };
  const auth = createAuth({ directory, fetcher, clock: () => now });
  await auth.initialize();
  const login = () => {
    const begun = auth.begin(), url = new URL(begun.url); nonce = url.searchParams.get("nonce");
    return { ...begun, state: url.searchParams.get("state"), code: "unit-test-code", cookies: begun.cookie.split(";")[0] };
  };
  return { auth, directory, requests, login, fetcher, clock: () => now,
    advance: milliseconds => { now += milliseconds; }, invalidate: () => { invalid = true; } };
}

test("cloud OAuth binds state to an HttpOnly browser cookie and stores only the server refresh credential", async t => {
  const h = await harness(t), login = h.login();
  assert.match(login.cookie, /HttpOnly; Secure; SameSite=Lax/);
  await assert.rejects(h.auth.complete({ ...login, cookies: "wrong" }), /state expired/);
  await h.auth.complete(login);
  assert.equal(createHash("sha256").update(h.requests[0].get("code_verifier")).digest("base64url"),
    new URL(login.url).searchParams.get("code_challenge"));
  assert.equal(h.requests[0].get("redirect_uri"), "https://tradfi-basis-monitor.onrender.com/");
  await assert.rejects(h.auth.complete(login), /state expired/);
  const saved = JSON.parse(await readFile(path.join(h.directory, "credentials.json"), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["authorizedAt", "client", "refreshToken"]);
  assert.equal((await stat(path.join(h.directory, "credentials.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(h.auth.status()), /test-only|unit-test-code|eyJ/);
  h.advance(56 * 60_000);
  await Promise.all([h.auth.token(), h.auth.token(), h.auth.token()]);
  assert.equal(h.requests.length, 2, "renewal is single-flight");
  assert.equal(h.requests[1].get("grant_type"), "refresh_token");
  const restarted = createAuth({ directory: h.directory, fetcher: h.fetcher, clock: h.clock });
  await restarted.initialize(); await restarted.token();
  assert.equal(restarted.status().authorized, true, "restart recovers renewable credentials");
});

test("cloud OAuth rejects expired states and wrong token audience before saving anything", async t => {
  const h = await harness(t), expired = h.login();
  h.advance(601_000);
  await assert.rejects(h.auth.complete(expired), /state expired/);
  h.invalidate();
  await assert.rejects(h.auth.complete(h.login()), /identity verification/);
  assert.equal(h.auth.status().authorized, false);
});

test("cloud subscriptions and token refresh continue without any browser snapshot requests", async () => {
  let now = Date.now(), token = "test-id-a", calls = [], published;
  const auth = { token: async () => token, status: () => ({ authorized: true }) };
  const factory = async options => {
    assert.equal(options.transport, "remote"); assert.deepEqual(options.env, {});
    const handlers = {}, instance = { closed: false, keys: [], on: (name, handler) => { handlers[name] = handler; },
      subscribe: async keys => { instance.keys = keys; handlers.status({ state: "connected" }); },
      close: () => { instance.closed = true; }, handlers };
    calls.push(instance); return instance;
  };
  const feed = createFeed({ auth, createTransport: factory, clock: () => now, publish: async payload => { published = payload; } });
  await feed.tick();
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.keys.length <= 20));
  assert.equal(calls.flatMap(call => call.keys).length, registry.size);
  const key = "orderbook:ibkr:FX:USD:JPY";
  calls[1].handlers.data({ streamKey: key, entries: [{ data: { bids: "150,10", asks: "151,20", bids_receive_ts_ms: now, asks_receive_ts_ms: now } }] });
  assert.equal(feed.status().messages, 1);
  await feed.push();
  assert.equal(published.quotes[0].symbol, "FX.USDJPY");
  assert.equal(published.quotes[0].marketTimestamp, now);
  now += 56 * 60_000; token = "test-id-b"; await feed.tick();
  assert.equal(calls.length, 4);
  assert.ok(calls[0].closed && calls[1].closed);
  assert.equal(feed.status().lastMessageAt, now - 56 * 60_000, "reconnect does not fake a new message timestamp");
  feed.stop();
});

test("cached stale quotes cannot become fresh on a publisher heartbeat", () => {
  const now = Date.now(), old = now - 90_000;
  const q = decode("orderbook:ibkr:STK:6976:TSEJ:JPY", { bids: "100,3", asks: "101,4",
    last_price: "100", last_tick_ts_ms: old, event_emit_ts_ms: now, specific_data: '{"stale":true}' }, now);
  assert.equal(q.timestamp, old); assert.equal(q.bid, null); assert.equal(q.ask, null);
  assert.equal(decode("account:private", {}, now), null);
  assert.equal(decode("orderbook:ibkr:STK:6976:TSEJ:JPY", { last_price: 100, event_emit_ts_ms: now }, now), null);
});

test("browser components neither exchange nor store Posley credentials", async () => {
  for (const name of ["PosleyOAuthCallback", "KoreanPerpMonitor"]) {
    const source = await readFile(new URL(`../app/components/${name}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /oauth2\/token|localStorage\.setItem|browserIdToken|code_verifier/);
  }
  const server = await readFile(new URL("../services/posley-cloud/server.mjs", import.meta.url), "utf8");
  assert.match(server, /listen\(8791, "127\.0\.0\.1"/);
  assert.match(server, /process\.env\.RENDER !== "true"/);
});

test("Render OAuth proxy requires site authentication and same-origin POST; callback is handled before React", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  const ctx = { waitUntil() {}, passThroughOnException() {} }, password = "test-only-password";
  const original = globalThis.fetch, originalUrl = process.env.POSLEY_CLOUD_INTERNAL_URL;
  process.env.POSLEY_CLOUD_INTERNAL_URL = "http://127.0.0.1:8791";
  const authCookie = "tradfi_access=" + createHmac("sha256", password).update("tradfi-basis-monitor-access-v1").digest("hex");
  const origin = "https://tradfi-basis-monitor.onrender.com";
  try {
    let response = await worker.fetch(new Request(`${origin}/api/posley-cloud/status`), { SITE_PASSWORD: password }, ctx);
    assert.equal(response.status, 401);
    response = await worker.fetch(new Request(`${origin}/api/posley-cloud/connect`, { method: "POST", headers: { cookie: authCookie, origin: "https://other.example" } }), { SITE_PASSWORD: password }, ctx);
    assert.equal(response.status, 403);
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).startsWith("http://127.0.0.1:8791/"));
      if (String(url).includes("/callback?")) {
        assert.equal(options.redirect, "manual");
        return new Response(null, { status: 303, headers: { location: `${origin}/posley-connect?connected=1` } });
      }
      return Response.json({ url: "https://posley.auth.us-east-1.amazoncognito.com/oauth2/authorize" },
        { headers: { "set-cookie": "__Host-posley_cloud_oauth=test; HttpOnly; Secure; Path=/" } });
    };
    response = await worker.fetch(new Request(`${origin}/api/posley-cloud/connect`, { method: "POST", headers: { cookie: authCookie, origin } }), { SITE_PASSWORD: password }, ctx);
    assert.equal(response.status, 200); assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    response = await worker.fetch(new Request(`${origin}/?code=test-code&state=posley_cloud_test`, { headers: { cookie: authCookie } }), { SITE_PASSWORD: password }, ctx);
    assert.equal(response.status, 303); assert.match(response.headers.get("location"), /connected=1/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally {
    globalThis.fetch = original;
    if (originalUrl === undefined) delete process.env.POSLEY_CLOUD_INTERNAL_URL; else process.env.POSLEY_CLOUD_INTERNAL_URL = originalUrl;
  }
});
