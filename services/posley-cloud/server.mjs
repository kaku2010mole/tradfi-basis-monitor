import http from "node:http";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAuth, ORIGIN } from "./auth.mjs";
import { createFeed } from "./feed.mjs";
import transport from "./transport.cjs";

// Never start an OAuth credential store on a developer laptop or ephemeral disk.
if (process.env.RENDER !== "true" || !existsSync("/var/data/jlp") || !process.env.SITE_PASSWORD) {
  throw new Error("Posley cloud access requires Render, its existing persistent disk and site authentication.");
}
const auth = createAuth({ directory: "/var/data/jlp/posley-access" });
await auth.initialize();
const pushToken = process.env.FUTU_PUSH_TOKEN?.trim() ||
  createHash("sha256").update(`futu-opend-readonly-push-v1:${process.env.SITE_PASSWORD}`).digest("hex");
const webPort = Number(process.env.PORT || 3000);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error("Invalid web port.");
const feed = createFeed({ auth, createTransport: transport.createTransport,
  publish: async payload => {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/hk-auction/ingest`, {
      method: "POST", headers: { Authorization: `Bearer ${pushToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Dashboard push failed.");
  },
});
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(request.url, "http://127.0.0.1:8791");
  function json(value, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  }
  try {
    if (url.pathname === "/connect" && request.method === "POST") {
      const login = auth.begin();
      response.setHeader("Set-Cookie", login.cookie);
      return json({ url: login.url });
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      try {
        const cookie = await auth.complete({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), cookies: request.headers.cookie });
        response.setHeader("Set-Cookie", cookie);
        void feed.tick();
        response.writeHead(303, { Location: `${ORIGIN}/posley-connect?connected=1` });
      } catch {
        // Do not reflect authorization codes, state, token bodies or provider errors.
        response.writeHead(303, { Location: `${ORIGIN}/posley-connect?error=authorization` });
      }
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/status") return json(feed.status());
    if (request.method === "GET" && url.pathname === "/snapshot") return json(feed.snapshot(url.searchParams.get("symbols")?.split(",").slice(0, 48)));
    return json({ error: "Not found." }, 404);
  } catch { return json({ error: "Posley cloud service is unavailable. Please retry." }, 503); }
});
server.listen(8791, "127.0.0.1", () => {
  console.log("Posley cloud service ready on loopback; renewable credentials stay on the Render persistent disk.");
  feed.start();
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { feed.stop(); server.close(); });
