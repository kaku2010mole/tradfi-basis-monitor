# JLP Research data service

The website homepage embeds `public/jlp-app/index.html`. Its read-only requests to
`/api/jlp/{state,history,export.csv,liquidations.csv}` are forwarded to this Python sidecar on
loopback. `scripts/start-render.mjs` starts and supervises it alongside the
website. No browser login or trading credentials are required.

The checked-in SQLite database seeds the 90-day public-market-data archive and
the locally collected samples available at integration time. New samples are
recorded once per minute. Render's current service has no persistent disk, so
samples collected after this seed may be lost when the instance is replaced.
To retain them across redeploys, attach persistent storage only after approval
and set `JLP_DATA_DIR` to that mounted directory. The service copies the seed
on first use of an empty data directory. `JLP_PORT` defaults to `8788`.

Run `python3 -m unittest -v test_data.py` in this directory to check the rate,
hedge, freshness, and history calculations.

## Jupiter Perps liquidation feed

The dashboard directly decodes finalized successful Jupiter trader liquidation CPI events, restricted to the JLP pool and BTC/ETH/SOL. Public Solana RPC is checked every 15 seconds; finalization and RPC delays also apply. Every event is stored separately and deduplicated by transaction and event index. All other live market samples retain one-minute storage. Liquidation records, checkpoints and the polling lock use `JLP_DATA_DIR`, beside the research database. Earlier unobserved periods are labelled as partial coverage. The existing Render ephemeral-storage limitation also applies to liquidation records. The one-time `liquidations-recovery-20261008.json` seed preserves the five observed events and last verified checkpoint across the v1 RPC fix deployment, then the collector resumes catch-up. It is not a substitute for persistent storage: later redeploys may lose newer events or exceed the catch-up pagination cap. No trading credentials are required. `JUPITER_MONITOR_RPC_URL` can select a dedicated read-only RPC.

The panel includes individual event alerts, long/short notional and fee statistics, selectable chart lines, market/side filters and CSV export through `/api/jlp/liquidations.csv`. Failed transactions and JLP loan liquidations are excluded. Missing event fields are retained as unavailable, and outage/catch-up states expose incomplete coverage rather than displaying missing events as zero. The collector accepts Solana v1 transactions and backs off for 2–30 minutes when the shared RPC returns HTTP 429; a dedicated `JUPITER_MONITOR_RPC_URL` remains necessary for reliable production coverage.

The IDL and CPI parsing follow the repository linked from [Jupiter developer docs](https://developers.jup.ag/docs/perps/index), specifically its [event example](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/blob/main/src/examples/get-perpetuals-events.ts). Run `python3 -m unittest test_data.py test_liquidations.py` for data calculations, checkpoint retries and liquidation deduplication.
