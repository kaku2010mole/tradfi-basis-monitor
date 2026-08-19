# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Optional Futu OpenD relay

The HK auction API (`/api/hk-auction/quotes`) reads Binance Futures directly. Futu
OpenAPI connects through a running OpenD instance, so a public deployment must set
`FUTU_RELAY_URL` to a small HTTPS relay beside OpenD. `FUTU_RELAY_TOKEN` is optional
and, when present, is sent as `Authorization: Bearer …`.

The dashboard sends the relay `POST { "symbols": ["HK.00700"], "depth": 10 }`.
The relay must answer with `{ "quotes": [...], "orderbooks": [...] }` (an
orderbook can alternatively be nested in its quote). Each quote uses this normalized
contract (camelCase aliases such as Futu's `bidPrice`, `bidVol`, `lastPrice` are
also accepted):

```json
{
  "symbol": "HK.00700",
  "name": "TENCENT",
  "marketState": "AUCTION",
  "auctionPrice": 612.5,
  "last": 611.5,
  "bid": 612,
  "ask": 612.5,
  "bidSize": 1400,
  "askSize": 24200,
  "bids": [{ "price": 612, "size": 1400 }],
  "asks": [{ "price": 612.5, "size": 24200 }],
  "marketTimestamp": 1787015430000
}
```

When sent separately, each orderbook is `{ "symbol": "HK.00700", "bids":
[{ "price": 612, "size": 1400 }], "asks": [...], "marketTimestamp": ... }`.

Prices and sizes must come from the subscribed Futu quote/order-book feeds. Missing
values should be `null` or omitted; the server never substitutes a previous close.

For a hosted Render instance, the safer default is the outbound-only pusher in
`services/futu-pusher/push.py`. It connects to OpenD at `127.0.0.1:11111` and
posts fresh two-sided books to `/api/hk-auction/ingest`; the Mac does not expose
OpenD or a home-network port. The endpoint accepts `FUTU_PUSH_TOKEN`, or derives
an isolated push credential from `SITE_PASSWORD` when a separate token is not
configured. The local derived token belongs in `.futu-push-token`, which is
ignored by Git.

On the relay Mac, double-click
`services/futu-pusher/Install Futu Relay.command` once. It installs a per-user
LaunchAgent that starts OpenD when needed, restarts the pusher after unexpected
exits, and uses `caffeinate -s` so the display may turn off while the Mac stays
awake on AC power. The pusher also retries OpenD startup and socket resets
without manual intervention. Futu OpenD still needs a valid logged-in session.

## Taker–Taker live execution

The password-protected `/taker` page supports paper DCA and explicitly armed
Hyperliquid ↔ Binance mainnet DCA. Hyperliquid uses an IOC order capped by the
configured slippage; Binance then submits the opposite market hedge sized from
the actual Hyperliquid fill. Any incomplete second leg stops the bot and is
reported as unhedged exposure. Credentials exist only in the current browser
tab and are cleared by closing or locking it. Keep the page visible while live
DCA is armed; hidden or stale tabs pause automatically.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
