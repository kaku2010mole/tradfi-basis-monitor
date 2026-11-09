"""Validate and combine Posley snapshots for the two JLP loan accounts."""

from datetime import datetime, timedelta, timezone
from math import isfinite

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MILLISECOND = timedelta(milliseconds=1)
_MAX_AGE_MS = 5 * 60_000
_MAX_ACCOUNT_SKEW_MS = 60_000
_MAX_FUTURE_MS = 5_000
_COLLATERAL = "jupiter:loan:JLP"
_DEBT = "jupiter:loan:USDC"
_LEGS = {_COLLATERAL: ("JLP", "LONG"), _DEBT: ("USDC", "SHORT")}


def _snapshot_time(value):
    if not isinstance(value, str):
        raise ValueError("Missing position snapshot time")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp - _EPOCH) // _MILLISECOND
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Invalid position snapshot time") from None


def _amount(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Invalid loan amount")
    try:
        amount = float(value)
    except (ValueError, OverflowError):
        raise ValueError("Invalid loan amount") from None
    if not isfinite(amount) or amount <= 0:
        raise ValueError("Invalid loan amount")
    return amount


def _account_position(result, now_ms):
    if not isinstance(result, dict) or result.get("truncated") or result.get("truncatedBy"):
        raise ValueError("Incomplete position response")
    meta, rows = result.get("meta"), result.get("rows")
    if not isinstance(meta, dict) or meta.get("freshnessStatus") != "fresh":
        raise ValueError("Position freshness is unavailable")
    if not isinstance(rows, list):
        raise ValueError("Incomplete position response")

    stamp = _snapshot_time(meta.get("latestSnapshotTime"))
    if not -_MAX_FUTURE_MS <= now_ms - stamp <= _MAX_AGE_MS:
        raise ValueError("Position snapshot is outside the freshness window")
    if _snapshot_time(meta.get("oldestReturnedSnapshotTime")) != stamp:
        raise ValueError("Account positions span different snapshots")

    amounts = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid position row")
        key = row.get("instrument_key")
        if row.get("position_type") != "LOAN":
            if isinstance(key, str) and key in _LEGS:
                raise ValueError("Loan leg identity is inconsistent")
            continue
        if not isinstance(key, str) or key not in _LEGS or key in amounts:
            raise ValueError("Unexpected or duplicate loan leg")
        if (row.get("symbol"), row.get("side")) != _LEGS[key]:
            raise ValueError("Loan leg identity is inconsistent")
        if _snapshot_time(row.get("snapshot_time")) != stamp:
            raise ValueError("Loan legs are not from the account snapshot")
        amounts[key] = _amount(row.get("amount"))

    if _COLLATERAL not in amounts:
        raise ValueError("JLP collateral snapshot is unconfirmed")
    # Posley projects both sides from one latest loan row, then omits zero legs.
    # A fresh collateral leg can therefore confirm repayment, but an empty
    # result cannot establish whether the account was closed or went offline.
    return amounts[_COLLATERAL], amounts.get(_DEBT, 0.0), stamp


def aggregate_positions(results, now_ms, prior=None):
    """Return one aggregate only when both ordered account responses validate."""
    if not isinstance(results, list) or len(results) != 2:
        raise ValueError("Both JLP loan accounts must have a snapshot")
    accounts = [_account_position(result, now_ms) for result in results]
    stamps = [stamp for _, _, stamp in accounts]
    if max(stamps) - min(stamps) > _MAX_ACCOUNT_SKEW_MS:
        raise ValueError("JLP account snapshots are too far apart")
    if prior is not None:
        previous = prior.get("accountSnapshotTimes") if isinstance(prior, dict) else None
        if (not isinstance(previous, list) or len(previous) != len(stamps)
                or any(type(stamp) is not int for stamp in previous)):
            raise ValueError("Previous account timestamps are unavailable")
        if any(stamp < old for stamp, old in zip(stamps, previous)):
            raise ValueError("JLP account snapshot time regressed")

    units = sum(collateral for collateral, _, _ in accounts)
    debt = sum(borrowed for _, borrowed, _ in accounts)
    if not isfinite(units) or not isfinite(debt):
        raise ValueError("Invalid aggregate loan amount")
    as_of = (_EPOCH + min(stamps) * _MILLISECOND).isoformat(timespec="milliseconds")
    return {
        "jlpUnits": units,
        "borrowedUsdc": debt,
        "asOf": as_of.replace("+00:00", "Z"),
        "accountSnapshotTimes": stamps,
    }
