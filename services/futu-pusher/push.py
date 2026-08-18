#!/usr/bin/env python3
"""Push read-only Futu OpenD books to the hosted auction monitor."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from futu import OpenQuoteContext, RET_OK, SubType


ROOT = Path(__file__).resolve().parents[2]
TOKEN_FILE = Path(os.getenv("FUTU_PUSH_TOKEN_FILE", ROOT / ".futu-push-token"))
PUSH_URL = os.getenv(
    "FUTU_PUSH_URL",
    "https://tradfi-basis-monitor.onrender.com/api/hk-auction/ingest",
)
OPEND_HOST = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
OPEND_PORT = int(os.getenv("FUTU_OPEND_PORT", "11111"))
SYMBOLS = [
    item.strip().upper()
    for item in os.getenv(
        "FUTU_SYMBOLS",
        "HK.00700,HK.01810,HK.01024,HK.03690,HK.09992,HK.00100,HK.02513",
    ).split(",")
    if item.strip()
]
INTERVAL_SECONDS = max(0.8, float(os.getenv("FUTU_PUSH_INTERVAL", "1")))
RUNNING = True


def stop(*_: object) -> None:
    global RUNNING
    RUNNING = False


def positive(value: object) -> float | None:
    try:
        number = float(value)
        return number if number > 0 else None
    except (TypeError, ValueError):
        return None


def levels(raw: object) -> list[dict[str, float]]:
    if not isinstance(raw, list):
        return []
    result: list[dict[str, float]] = []
    for level in raw[:10]:
        if not isinstance(level, (list, tuple)) or len(level) < 2:
            continue
        price, size = positive(level[0]), positive(level[1])
        if price is not None and size is not None:
            result.append({"price": price, "size": size})
    return result


def build_payload(context: OpenQuoteContext) -> dict[str, object]:
    generated_at = int(time.time() * 1000)
    state_ret, state = context.get_global_state()
    market_state = str(state.get("market_hk")) if state_ret == RET_OK and hasattr(state, "get") else None
    snapshot_ret, snapshot = context.get_market_snapshot(SYMBOLS)
    if snapshot_ret != RET_OK:
        raise RuntimeError(f"Futu snapshot failed: {snapshot}")
    snapshot_by_code = {str(row.get("code")): row for _, row in snapshot.iterrows()}
    market_closed = market_state is not None and market_state.upper() == "CLOSED"
    quotes: list[dict[str, object]] = []
    orderbooks: list[dict[str, object]] = []
    for symbol in SYMBOLS:
        row = snapshot_by_code.get(symbol)
        book_ret, book = context.get_order_book(symbol, num=10)
        if row is None:
            continue
        bids = levels(book.get("Bid", [])) if book_ret == RET_OK else []
        asks = levels(book.get("Ask", [])) if book_ret == RET_OK else []
        last = positive(row.get("last_price"))
        if (not bids or not asks) and not (market_closed and last is not None):
            continue
        quotes.append({
            "symbol": symbol,
            "name": str(row.get("name")),
            "marketState": market_state,
            "auctionPrice": None,
            "last": last,
            "bid": bids[0]["price"] if bids else None,
            "ask": asks[0]["price"] if asks else None,
            "bidSize": bids[0]["size"] if bids else None,
            "askSize": asks[0]["size"] if asks else None,
            # Futu order-book snapshots do not include an exchange timestamp.
            # A successful synchronous OpenD response time is used as freshness,
            # while last_price is never used as the auction reference.
            "marketTimestamp": generated_at,
        })
        if bids and asks:
            orderbooks.append({"symbol": symbol, "bids": bids, "asks": asks, "marketTimestamp": generated_at})
    if not quotes:
        raise RuntimeError("Futu returned no complete two-sided books.")
    return {"generatedAt": generated_at, "quotes": quotes, "orderbooks": orderbooks}


def push(payload: dict[str, object], token: str) -> None:
    request = urllib.request.Request(
        PUSH_URL,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "futu-opend-pusher/1"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        if response.status != 202:
            raise RuntimeError(f"Push endpoint returned HTTP {response.status}")


def main() -> int:
    if not TOKEN_FILE.exists():
        print(f"Missing push token: {TOKEN_FILE}", file=sys.stderr)
        return 2
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        print("Push token is invalid.", file=sys.stderr)
        return 2
    context = OpenQuoteContext(host=OPEND_HOST, port=OPEND_PORT)
    try:
        subscribe_ret, message = context.subscribe(SYMBOLS, [SubType.QUOTE, SubType.ORDER_BOOK], subscribe_push=False)
        if subscribe_ret != RET_OK:
            raise RuntimeError(f"Futu subscription failed: {message}")
        failures = 0
        while RUNNING:
            started = time.monotonic()
            try:
                push(build_payload(context), token)
                if failures:
                    print("Futu push recovered.", flush=True)
                failures = 0
            except (RuntimeError, urllib.error.URLError, TimeoutError) as error:
                failures += 1
                if failures == 1 or failures % 30 == 0:
                    print(f"Futu push unavailable: {error}", file=sys.stderr, flush=True)
            time.sleep(max(0.1, INTERVAL_SECONDS - (time.monotonic() - started)))
    finally:
        context.close()
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raise SystemExit(main())
