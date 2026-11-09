"""Regression tests for reconciling two Posley JLP loan accounts."""

from datetime import datetime, timezone
import unittest

from jlp_position_aggregate import aggregate_positions


NOW = 1_800_000_000_000


def iso(stamp):
    return datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).isoformat()


def snapshot(stamp, collateral="100", debt="25.25"):
    rows = [
        {
            "instrument_key": "jupiter:loan:JLP",
            "position_type": "LOAN",
            "symbol": "JLP",
            "side": "LONG",
            "amount": collateral,
            "snapshot_time": iso(stamp),
        }
    ]
    if debt is not None:
        rows.append({
            "instrument_key": "jupiter:loan:USDC",
            "position_type": "LOAN",
            "symbol": "USDC",
            "side": "SHORT",
            "amount": debt,
            "snapshot_time": iso(stamp),
        })
    return {
        "meta": {
            "freshnessStatus": "fresh",
            "latestSnapshotTime": iso(stamp),
            "oldestReturnedSnapshotTime": iso(stamp),
        },
        "rows": rows,
    }


class PositionAggregateTests(unittest.TestCase):
    def test_combines_fresh_balances_and_uses_oldest_source_time(self):
        first, second = NOW - 5_000, NOW - 10_000
        result = aggregate_positions(
            [snapshot(first), snapshot(second, "50", "10")], NOW,
        )
        self.assertEqual(result, {
            "jlpUnits": 150.0,
            "borrowedUsdc": 35.25,
            "asOf": iso(second).replace("+00:00", ".000Z"),
            "accountSnapshotTimes": [first, second],
        })

    def test_fresh_collateral_confirms_repayment_when_debt_leg_is_absent(self):
        result = aggregate_positions(
            [snapshot(NOW, debt=None), snapshot(NOW, "50", "10")], NOW,
        )
        self.assertEqual(result["jlpUnits"], 150.0)
        self.assertEqual(result["borrowedUsdc"], 10.0)

    def test_missing_stale_or_incomplete_account_rejects_whole_aggregate(self):
        partial = snapshot(NOW)
        partial["rows"].pop(0)
        empty = snapshot(NOW)
        empty["rows"] = []
        missing_time = snapshot(NOW)
        missing_time["meta"].pop("latestSnapshotTime")
        stale = snapshot(NOW - 301_000)
        truncated = dict(snapshot(NOW), truncated=True)
        for bad in (None, partial, empty, missing_time, stale, truncated):
            with self.subTest(response=bad), self.assertRaises(ValueError):
                aggregate_positions([snapshot(NOW), bad], NOW)
        with self.assertRaises(ValueError):
            aggregate_positions([snapshot(NOW)], NOW)

    def test_rejects_duplicate_mismatched_and_unaligned_loan_legs(self):
        duplicate = snapshot(NOW)
        duplicate["rows"].append(duplicate["rows"][1])
        mismatched = snapshot(NOW)
        mismatched["rows"][1]["side"] = "LONG"
        mislabeled = snapshot(NOW)
        mislabeled["rows"][1]["position_type"] = "SPOT"
        unaligned = snapshot(NOW)
        unaligned["rows"][1]["snapshot_time"] = iso(NOW - 5_000)
        invalid = snapshot(NOW, debt="-10")
        for bad in (duplicate, mismatched, mislabeled, unaligned, invalid):
            with self.subTest(response=bad), self.assertRaises(ValueError):
                aggregate_positions([snapshot(NOW), bad], NOW)

    def test_rejects_regression_even_when_aggregate_timestamp_would_increase(self):
        prior = aggregate_positions(
            [snapshot(NOW - 20_000), snapshot(NOW - 30_000)], NOW,
        )
        with self.assertRaisesRegex(ValueError, "regressed"):
            aggregate_positions(
                [snapshot(NOW - 21_000), snapshot(NOW - 15_000)], NOW, prior,
            )
        result = aggregate_positions(
            [snapshot(NOW - 20_000), snapshot(NOW - 15_000, debt="24")], NOW, prior,
        )
        self.assertEqual(result["borrowedUsdc"], 49.25)

    def test_rejects_excessively_skewed_or_future_snapshots(self):
        for bad_time in (NOW - 61_000, NOW + 6_000):
            with self.subTest(stamp=bad_time), self.assertRaises(ValueError):
                aggregate_positions([snapshot(NOW), snapshot(bad_time)], NOW)


if __name__ == "__main__":
    unittest.main()
