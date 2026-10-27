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

## Taiwan cash and pre-open trial quotes

Set `FUGLE_API_KEY` only in the Render service's secret environment variables.
Never use a `NEXT_PUBLIC_` variable or put the key in source, logs or browser storage.
The `/api/stock-basis/taiwan` server requests one Fugle intraday quote for each of
the eight Taiwan stocks at most once per minute while the panel is being viewed.
One shared cache coalesces concurrent viewers. It keeps actual quote timestamps
and last observations through failures, with additional backoff for HTTP 401/403/429.
This in-memory quota coordination is per Node process; use a shared cache/collector
before scaling to multiple replicas. No paid subscription is enabled by this code.

The Taiwan section has two independent tabs, defaulting to **Live / Pre-open**.
It compares the current cash BBO midpoint (last trade only if no valid book), or
the current trial price when the provider flags a trial, with Bitget's midpoint.
`deviation = perp midpoint × USD/TWD / cash price − 1`. USD/TWD comes from an
independent Yahoo currency quote, cached once per minute for all viewers. This
display explicitly assumes USDT = USD and one Taiwan share per perp price unit;
the contract multiplier is not independently verified. FX is indicative, not BBO.
Cash older than 120s, perp BBO older than 60s, or FX older than 15 minutes suppresses
the comparison (FX fetching must also be within 120s). Failures preserve original
timestamps and never substitute the oracle. Trial books are simulated: directional
buy/sell spreads are only shown with regular-session cash BBO, still indicative.
API timestamps in microseconds are converted to ms.

**Model** resets to that day's 14:00 oracle at 14:00 HKT/Taipei on every verified
TWSE trading day. Before 14:00 and on holidays/weekends, it uses the most recent
trading-day 14:00 anchor. TWTSM follows U.S. TSM ADR returns; TWUMC (TWSE 2303,
United Microelectronics / 聯電) follows U.S. UMC ADR returns. Each uses
`own 14:00 oracle × own ADR current / own ADR at-or-before anchor` and resets its
ADR denominator with the oracle. The 5:1 ADS/common-share ratio is not used in this
normalized return model. UMC's listing is verified by
https://www.umc.com/en/Html/faqs. ADR observations and caches are isolated by ticker;
missing UMC data never falls back to TSM or a perpetual. Available office quotes
are preferred; Yahoo extended-hours 5m history is shared for 30s per ADR and
retained observations keep their original timestamps during outages.
There are no current-cash adjustments. Missing new index candles are retried and
never replaced with an older anchor. The separate historical ADR opening study
keeps its prior-date anchor and 09:00 cutoff after the model resets. It is folded below
the model cards. Summary colors and expanded details depend only on the active tab.
One-minute snapshots are not tick-complete and are not an auction history archive.
Confirm your provider's display/data-sharing permissions for the intended audience.

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

The Oracle stock panel also uses the outbound OpenD push for the U.S.-listed
Japanese ADRs `US.SONY`, `US.TM` and `US.MUFG`. Their ratios are respectively
1, 10 and 1 Tokyo ordinary shares per ADR. The night-session ADR/perp edge
compares fresh USD bid/ask books directly, without USD/JPY or a closed Tokyo
quote as an executable leg. Deploy the server ingest allowlist before running
`services/futu-pusher/Update Futu Symbols.command` on the relay Mac.

The dedicated `/skhynix-7709` page compares the existing Binance
`CSOPSKHYNIX2LUSDT` perpetual with Futu `HK.07709` cash quotes. The default
OpenD relay subscription now includes `HK.07709`; after deploying this change,
run `services/futu-pusher/Update Futu Symbols.command` on the relay Mac (and
include `HK.07709` if `FUTU_SYMBOLS` is overridden). The cash mode needs its
one-minute history and a fresh two-sided book for live updates. The fair-price
chart uses the first aligned 7709 price in the selected window as its anchor,
then applies the +2× SK Hynix return adjusted by the relative USD/KRW move.
Cash prices are shown in HKD using the existing fixed 7.84 HKD/USD conversion;
this is a conditional monitoring estimate, not an independent NAV or trade signal.

On the relay Mac, double-click
`services/futu-pusher/Install Futu Relay.command` once. It installs a per-user
LaunchAgent that starts OpenD when needed, restarts the pusher after unexpected
exits, and uses `caffeinate -s` so the display may turn off while the Mac stays
awake on AC power. The pusher also retries OpenD startup and socket resets
without manual intervention. Futu OpenD still needs a valid logged-in session.

## Posley ADR feed

The HK Auction Basis page discovers currently published ADR order-book keys from
the Posley Redis stream directory after Cognito/Google login, then subscribes to
the exact returned IBKR or Futu stream keys. Default mappings include TCEHY for
Tencent (1:1), XIACY for Xiaomi (1 ADR:5 HK shares), KSHTY for Kuaishou
(5 ADRs:1 HK share), MPNGY for Meituan (1 ADR:2 HK shares), PMRTY for Pop Mart
(1:1), and MMXGY for MiniMax (5 ADRs:1 HK share). Every pair can override the ADR ticker and HK-shares-per-ADR ratio in the
page's pair setup. Live ADR quotes use a 30-second freshness indicator; the most
recent US quote can remain an explicitly labelled benchmark for up to 96 hours
so the HK pre-open session can compare against the prior US close.

## Learn More

## SMIC opening outlook

`/smic-opening` is a standalone SMIC (00981.HK, 中芯国际) dashboard. It polls
`/api/smic-opening` every two seconds while visible. The input is the actual
`orderbook:futu:US.SMH` ETF bid/ask midpoint from the existing office pusher,
not an SMH perpetual and not a delayed Yahoo quote. Add the updated
`services/futu-pusher/posley-adr-pusher.mjs` to the existing Mac relay after
deploying the server ingest allowlist; no new credential or subscription is needed.

The price return is measured against the official regular-session close before
the U.S. session paired with the **next** Hong Kong opening. That anchor stays
fixed through the U.S. close and after-hours; it changes when the target Hong
Kong opening rolls. Live quotes older than 30 seconds retain their actual time
and are marked stale. Before, during and after the U.S. session, the UI shows a
provisional estimate; historical performance uses completed SMH daily returns
and does not validate intraday prediction accuracy.

A one-calendar-year OLS predicts the opening gap; fixed 1-percentage-point
cohorts provide empirical higher/lower/unchanged proportions, Wilson intervals,
sample counts and the historical middle 80% outcome range. These empirical
proportions are not a separately calibrated live probability model. Raw SMH
price returns match the live price/previous-close definition. The dated bundled
research sample provides a transparent fallback; Yahoo daily history refreshes
server-side, coalesced for all viewers, at most every 30 minutes. A history failure
does not relabel old observations as new or break the live ETF connection.

The verified HKEX/NYSE 2026–2027 calendars handle holidays, early closes and
U.S. daylight saving. Zero or multiple U.S. sessions across the target HK window
suspend the automatic single-session estimate. Unverified calendar years suspend
it too. The manual scenario calculator remains explicitly labelled. An unfinished
HK daily close cannot become the reference for an implied HK opening price.

Historical source: Yahoo Finance 0981.HK and SMH daily OHLC, with initial paired
research through 2026-10-26. Calendar sources: HKEX circular CT/075/25 (2026),
CT/077/26 (2027), and https://www.nyse.com/trade/hours-calendars.

Focused checks: `node --test tests/smic-opening.test.mjs
tests/smic-opening-api.test.mjs tests/posley-stock-additions.test.mjs`
(run the build before the API checks).

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
# DOOSENER opening outlook

The existing `/smic-opening` page now has an instrument selector for SMIC
(`00981.HK`) and Doosan Enerbility (`034020.KS`, DOOSENER). A direct link to
Doosan is `/smic-opening?asset=doosener`; switching instruments resets manual
scenarios and stops polling the previous instrument. The settings menu links
to the shared opening-outlook page.

`/api/doosener-opening` uses a rolling one-calendar-year OLS model with EWY
regular-session open-to-current return and SMH current-to-reference-close
return. Actual ETF BBO midpoints come from `orderbook:futu:US.EWY` and
`orderbook:futu:US.SMH` through the existing authenticated office pusher.
The relay must include both stream keys; there are 35 subscriptions in two
groups of 20 and 15, below the per-connection cap. No perpetual proxy is used.

EWY has explicit session states:

- Before the associated U.S. session, the displayed **early estimate** assumes
  EWY intraday return is 0%; the API preserves `ewy.return: null` and labels
  `ewy.effectiveReturn: 0` as an assumption. Premarket EWY quote changes cannot
  masquerade as a regular-session return.
- During the U.S. session, live EWY midpoint is divided by that session's
  reported regular opening price. A missing opening anchor suspends the
  forecast, rather than substituting a prior session's opening price.
- After the U.S. close, confirmed EWY regular close/open return is fixed. Its
  after-hours quote does not enter the EWY intraday factor. Confirmation can
  take up to ten minutes; the page explains the wait. SMH remains live against
  its original preceding regular close through the next KRX opening.

Yahoo daily OHLC refreshes the historical model and anchors in the background;
EWY session anchors are checked at 15-second intervals when missing (30 seconds
on failure). Stale ETF quotes retain their original timestamp and estimate,
and the page marks them stale. Missing/future-dated inputs cannot create a live
forecast. An unfinished Korean daily close cannot anchor an implied price.

Direction probabilities use **both factors** in nine historical joint cohorts,
with fixed boundaries at −1% and +1% for each factor. The UI shows cohort counts,
Wilson intervals, and the historical middle-80% opening range, plus separate
one-percentage-point SMH/EWY reference tables. Empty cohorts remain empty and
small cohorts are labelled. These are historical frequencies, not a calibrated
intraday probability model. Walk-forward accuracy uses completed U.S. sessions
only and excludes actual flat openings for direction accuracy.

The target is the official KRX cash opening, not Nextrade or the perpetual
market. Standard opening is 09:00 KST / 08:00 HKT. Calendar rules cover
2026–2027 (KRX holidays, Korean public holidays, usual first-session/CSAT delayed
openings, and NYSE holidays/early closes); unexpected changes need an update.
The target rolls at KRX opening independently from SMIC's Hong Kong target.
Zero/multiple U.S. sessions across a Korean holiday suspend automatic forecasts.

## ZHONGJI and GIGADEV opening outlook

The same `/smic-opening` selector also includes Zhongji InnoLight H shares
(`/smic-opening?asset=zhongji`, 03308.HK) and GigaDevice H shares
(`/smic-opening?asset=gigadev`, 03986.HK). Each selected panel polls
`/api/peer-opening?asset=...` every two seconds while visible; switching panels
unmounts the prior poller and resets manual scenarios.

Both regressions combine SMH close-to-current return with a U.S. stock's
regular-open-to-current return: LITE for Zhongji, MU for GigaDevice. Real BBOs
come from `orderbook:futu:US.SMH`, `orderbook:futu:US.LITE` and
`orderbook:futu:US.MU`. Deploy the updated ingest allowlist **before** updating
the office pusher, which adds LITE and MU to its existing two connections
(20/17 streams, below the 25-stream per-connection limit).

The stock factor follows the EWY session-timing rules above: explicit 0%
assumption before the associated U.S. regular open, no substituted opening
anchor, and confirmed regular open-to-close return fixed after the session.
SMH continues live against the same preceding regular close until the HK
opening rolls. Each price keeps its original timestamp; stale inputs remain
labelled. Implied HK opening prices require the completed preceding HK close.

Training uses at most one calendar year before the target HK opening. Zhongji
starts at its 2026-07-30 IPO, with 30 prior observations required (58 rows,
28 forward predictions in the dated seed). GigaDevice starts at its 2026-01-13
IPO, with 60 required (183 rows, 123 predictions). A-share data and history
belonging to reused HK stock codes are excluded. Both seeds are dated
2026-10-27 and refresh from Yahoo daily OHLC. Existing verified HK/US trading
calendars govern the target and skip zero/multiple-U.S.-session windows.

Main probabilities are joint historical frequencies in fixed 3×3 cohorts,
SMH boundaries −1%/+1% and stock boundaries −2%/+2%, including flat openings.
Counts, Wilson 95% intervals and sparse-cohort labels accompany them. Separate
fixed 2-percentage-point tables reproduce the research marginal groups.
Neither the cohorts nor the completed-session forward accuracy establish
calibrated probabilities or equal accuracy during live intraday estimates.

Checks: `node --test tests/hk-peer-opening*.test.mjs` after building. Tests
reconcile independent research coefficients/errors, IPO clipping, prior-only
training, true stock inputs, empty/missing anchors, fixed after-hours stock
returns and stale/future timestamps.
