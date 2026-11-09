# JLP Research data service

The website homepage embeds `public/jlp-app/index.html`. Its read-only requests to
`/api/jlp/{state,history,export.csv,liquidations.csv}` are forwarded to this Python sidecar on
loopback. `scripts/start-render.mjs` starts and supervises it alongside the
website. The chart requests select only the metrics needed for the visible
charts. The full history and CSV endpoints remain available.

On a password-protected site, set `JLP_POSITION_SNAPSHOT` in the server
environment to an aggregate JSON object with numeric `jlpUnits` and
`borrowedUsdc` and an ISO timestamp `asOf`. The authenticated calculator uses
the snapshot by default and values it with current inputs. It models the
Hyperliquid hedge and margin from the selected hedge leverage. The snapshot is
dated and can be switched off for manual estimates.

To enable automatic updates on Render, set `JLP_POSLEY_ACCOUNT_IDS` to the
two verified JLP loan account IDs, separated by a comma. Set
`JLP_POSLEY_MCP_API_KEY` to a Posley managed service key with
`mcp:pg:read` and a tool allowlist containing only `get_account_positions`.
Configure the key in the hosting provider's server environment.

The recorder polls every minute, validates both snapshots together and stores
only the aggregate and source timestamps on the persistent disk. The site
serves it through the authenticated estimator endpoint. The page checks every
15 seconds while visible and recomputes when units or debt change. Before the
first successful sync, it can use `JLP_POSITION_SNAPSHOT`. On a later failure,
it labels the last verified aggregate as delayed. Posley omits closed legs.
A fresh collateral leg can confirm repayment, but an empty account response
cannot distinguish closure from missing coverage.

The checked-in SQLite database seeds the 90-day public-market-data archive and
the locally collected samples available at integration time. New samples are
bucketed by observation minute and written immediately after successful fetches.
Later failures never remove successful observations. Failed disk writes retain
the original minute timestamps in a retry queue, retried every five seconds.
SIGTERM also flushes pending rows. No missing minutes are fabricated.

Persistent storage requires an approved Render disk. The launcher selects
`/var/data/jlp` when that mount exists, or respects an explicit `JLP_DATA_DIR`.
Without either, the local fallback remains ephemeral on Render. The service
copies the seed only on first use of an empty data directory. Export the full
90-day CSV before the first disk migration and merge real observations into the
seed with `import_history.py`; never replace an existing persistent database.
`JLP_PORT` defaults to `8788`. `/api/state` exposes recorder write time, pending
rows, errors and whether the data directory is a mount point. Collectors run
without an open browser. A disk prevents history loss on deploy, not collection
during server downtime; upstream outages still create honest chart gaps.

Run `python3 -m unittest -v test_data.py` in this directory to check the rate,
hedge, freshness, and history calculations.

## Jupiter Perps liquidation feed

The dashboard directly decodes finalized successful Jupiter trader liquidation CPI events, restricted to the JLP pool and BTC/ETH/SOL. Public Solana RPC is checked every 15 seconds; finalization and RPC delays also apply. Every event is stored separately and deduplicated by transaction and event index. All other live market samples retain one-minute storage. Liquidation records, checkpoints and the polling lock use `JLP_DATA_DIR`, beside the research database. Earlier unobserved periods are labelled as partial coverage. The existing Render ephemeral-storage limitation also applies to liquidation records. The one-time `liquidations-recovery-20261008.json` seed preserves the five observed events and last verified checkpoint across the v1 RPC fix deployment, then the collector resumes catch-up. It is not a substitute for persistent storage: later redeploys may lose newer events or exceed the catch-up pagination cap. No trading credentials are required. `JUPITER_MONITOR_RPC_URL` can select a dedicated read-only RPC.

The feed continues to record activity and supports CSV export through `/api/jlp/liquidations.csv`. It excludes failed transactions and JLP loan liquidations and records missing fields as unavailable. The collector accepts Solana v1 transactions and backs off for 2–30 minutes when the shared RPC returns HTTP 429; a dedicated `JUPITER_MONITOR_RPC_URL` remains necessary for reliable production coverage.

The IDL and CPI parsing follow the repository linked from [Jupiter developer docs](https://developers.jup.ag/docs/perps/index), specifically its [event example](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/blob/main/src/examples/get-perpetuals-events.ts). Run `python3 -m unittest test_data.py test_liquidations.py` for data calculations, checkpoint retries and liquidation deduplication.
