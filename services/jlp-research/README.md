# JLP Research data service

The website homepage embeds `public/jlp-app/index.html`. Its read-only requests to
`/api/jlp/{state,history,export.csv}` are forwarded to this Python sidecar on
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
