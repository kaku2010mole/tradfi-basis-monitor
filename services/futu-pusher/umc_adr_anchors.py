"""Read-only UMC 17:00 HKT reference bars, separate from the live BBO feed."""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HKT = timezone(timedelta(hours=8))
EASTERN = ZoneInfo("America/New_York")
DAY_MS = 86_400_000
CACHE = Path(__file__).with_name(".umc-adr-anchors.json")


def clean(points, now_ms):
    """Bound and validate disk/feed data without promoting it to a live quote."""
    result = {}
    for point in points if isinstance(points, list) else []:
        if not isinstance(point, dict):
            continue
        price, stamp, volume = (point.get(key) for key in ("price", "timestamp", "volume"))
        if (isinstance(price, (int, float)) and not isinstance(price, bool) and math.isfinite(price) and price > 0
                and isinstance(stamp, int) and now_ms - 40 * DAY_MS <= stamp <= now_ms - 60_000
                and stamp % DAY_MS == 9 * 3_600_000
                and isinstance(volume, int) and not isinstance(volume, bool) and volume >= 0):
            result[stamp] = {"price": price, "timestamp": stamp, "volume": volume}
    return sorted(result.values(), key=lambda item: item["timestamp"])[-40:]


def parse_bars(rows, now_ms):
    points = []
    for row in rows:
        if row.get("code") != "US.UMC":
            continue
        try:
            # Futu U.S. time_key is New York local time, not Hong Kong time.
            moment = datetime.fromisoformat(str(row["time_key"]))
            moment = moment.replace(tzinfo=EASTERN) if moment.tzinfo is None else moment
            price, volume = float(row["open"]), float(row["volume"])
            if not math.isfinite(volume) or not volume.is_integer():
                continue
            points.append({"price": price, "timestamp": int(moment.timestamp() * 1000), "volume": int(volume)})
        except (KeyError, ValueError, TypeError, OverflowError):
            continue
    # A zero-volume bar is an allowed carried-forward reference, never a BBO.
    return clean(points, now_ms)


def fetch_day(context, day, now_ms):
    from futu import AuType, KLType, RET_OK, Session
    result, page = [], None
    for _ in range(4):  # One 24h trading date fits in at most two 1,000-bar pages.
        ret, frame, page = context.request_history_kline(
            "US.UMC", start=day.isoformat(), end=day.isoformat(),
            ktype=KLType.K_1M, autype=AuType.NONE, max_count=1000,
            session=Session.ALL, page_req_key=page)
        if ret != RET_OK:
            raise RuntimeError("Futu UMC minute history unavailable")
        result.extend(parse_bars(frame.to_dict("records"), now_ms))
        if not page:
            return clean(result, now_ms)
        time.sleep(2.1)  # Stay below the historical-request rate limit.
    raise RuntimeError("Futu UMC history exceeded the bounded page limit")


def load_cache(now_ms):
    try:
        return clean(json.loads(CACHE.read_text(encoding="utf-8")), now_ms)
    except (OSError, ValueError, TypeError):
        return []


def save_cache(points):
    temporary = CACHE.with_suffix(".tmp")
    temporary.write_text(json.dumps(points), encoding="utf-8")
    os.replace(temporary, CACHE)


def publish(points, token, push_url):
    if not points:
        return
    body = json.dumps({"generatedAt": int(time.time() * 1000), "quotes": [], "umcAdrAnchors": points}).encode()
    request = urllib.request.Request(push_url, data=body, method="POST",
                                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=8) as response:
        if response.status != 202:
            raise RuntimeError(f"UMC anchor push HTTP {response.status}")


def due_day(points, now_ms, attempted):
    now = datetime.fromtimestamp(now_ms / 1000, HKT)
    latest = now.date() if (now.hour, now.minute) >= (17, 1) else now.date() - timedelta(days=1)
    known = {datetime.fromtimestamp(point["timestamp"] / 1000, HKT).date() for point in points}
    # Recover recent anchors after an install/cache loss, one date per minute.
    for offset in range(14):
        day = latest - timedelta(days=offset)
        if day.weekday() >= 5 or day in known:
            continue
        retry_ms = 60_000 if day == now.date() and (now.hour, now.minute) < (17, 30) else 600_000
        if day != now.date() and day in attempted:
            continue
        if now_ms - attempted.get(day, 0) >= retry_ms:
            return day
    return None


def run(token, push_url, host, port, running):
    from futu import OpenQuoteContext
    points, attempted, context, failures = load_cache(int(time.time() * 1000)), {}, None, 0
    try:
        while running():
            started, now_ms = time.monotonic(), int(time.time() * 1000)
            points = clean(points, now_ms)
            day = due_day(points, now_ms, attempted)
            try:
                # Re-publish the tiny saved anchor set after Render restarts.
                publish(points, token, push_url)
                if day is not None:
                    context = context or OpenQuoteContext(host=host, port=port)
                    observations = fetch_day(context, day, now_ms)
                    attempted[day] = now_ms
                    points = clean([*points, *observations], now_ms)
                    if observations:
                        save_cache(points)
                        publish(points, token, push_url)
                        latest = observations[-1]
                        print(f"UMC 17:00 HKT anchor loaded: {day} USD {latest['price']:.3f}, volume {latest['volume']}; indicative.", flush=True)
                failures = 0
            except Exception as error:
                failures += 1
                if failures == 1 or failures % 30 == 0:
                    # Never log request headers or credentials.
                    print(f"UMC anchor relay retry ({type(error).__name__}); other feeds continue.", file=sys.stderr, flush=True)
                if context is not None:
                    context.close()
                    context = None
            # Interruptible wait; only this lightweight worker is affected.
            while running() and time.monotonic() - started < 60:
                time.sleep(1)
    finally:
        if context is not None:
            context.close()


def start(token, push_url, host, port, running):
    thread = threading.Thread(target=run, args=(token, push_url, host, port, running), name="umc-adr-anchors", daemon=True)
    thread.start()
    return thread
