import unittest
from datetime import datetime
from umc_adr_anchors import HKT, clean, due_day, parse_bars


def at(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=HKT).timestamp() * 1000)


class UmcAnchorsTest(unittest.TestCase):
    def test_zero_volume_uses_open_not_later_close(self):
        rows = [{"code": "US.UMC", "time_key": "2026-10-20 05:00:00", "open": 19.67, "close": 19.66, "volume": 0}]
        self.assertEqual(parse_bars(rows, at("2026-10-20T17:01:00")), [
            {"price": 19.67, "timestamp": at("2026-10-20T17:00:00"), "volume": 0}])
        self.assertEqual(parse_bars(rows, at("2026-10-20T17:00:59")), [])

    def test_dst_changes_us_hour_not_hkt_target(self):
        rows = [{"code": "US.UMC", "time_key": "2026-11-03 04:00:00", "open": 20, "volume": 10}]
        self.assertEqual(parse_bars(rows, at("2026-11-03T17:01:00"))[0]["timestamp"], at("2026-11-03T17:00:00"))
        rows[0]["time_key"] = "2026-11-03 05:00:00"
        self.assertEqual(parse_bars(rows, at("2026-11-03T18:01:00")), [])

    def test_wrong_symbol_old_boundary_invalid_numbers_rejected(self):
        rows = [{"code": "US.TSM", "time_key": "2026-10-20 05:00:00", "open": 19.67, "volume": 0},
                {"code": "US.UMC", "time_key": "2026-10-20 02:00:00", "open": 19.59, "volume": 0}]
        self.assertEqual(parse_bars(rows, at("2026-10-20T17:01:00")), [])
        point = {"price": float("nan"), "timestamp": at("2026-10-20T17:00:00"), "volume": 0}
        self.assertEqual(clean([point], at("2026-10-20T17:01:00")), [])

    def test_daily_cache_and_retry_schedule(self):
        now = at("2026-10-20T17:01:00")
        today = datetime(2026, 10, 20).date()
        self.assertEqual(due_day([], now, {}), today)
        self.assertNotEqual(due_day([], now + 1000, {today: now}), today)
        self.assertEqual(due_day([], now + 60_000, {today: now}), today)
        points = [{"price": 19.67, "timestamp": now - 60_000, "volume": 0}]
        self.assertNotEqual(due_day(points, now, {}), today, "successful anchor isn't re-fetched every minute")
        self.assertEqual(due_day(points, at("2026-10-21T17:01:00"), {}), datetime(2026, 10, 21).date())
        self.assertNotEqual(due_day([], at("2026-10-20T17:00:59"), {}), today)


if __name__ == "__main__":
    unittest.main()
