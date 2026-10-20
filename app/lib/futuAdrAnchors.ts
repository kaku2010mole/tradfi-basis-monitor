// Historical reference observations, deliberately separate from executable quotes.
export type FutuAdrAnchor = { price: number; timestamp: number; volume: number };
const DAY = 86_400_000;
export function validFutuAdrAnchors(value: unknown, now: number): value is FutuAdrAnchor[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 40 && value.every((point) =>
    point && typeof point === "object" &&
    Number.isFinite(point.price) && point.price > 0 &&
    Number.isInteger(point.volume) && point.volume >= 0 &&
    Number.isInteger(point.timestamp) && point.timestamp >= now - 40 * DAY &&
    point.timestamp + 60_000 <= now &&
    // 17:00 HKT = 09:00 UTC, including U.S. daylight-saving transitions.
    point.timestamp % DAY === 9 * 3_600_000);
}
export function mergeFutuAdrAnchors(older: FutuAdrAnchor[] = [], newer: FutuAdrAnchor[] = [], now = Date.now()) {
  const byTime = new Map<number, FutuAdrAnchor>();
  for (const point of [...older, ...newer]) {
    if (validFutuAdrAnchors([point], now)) byTime.set(point.timestamp, {
      price: point.price, timestamp: point.timestamp, volume: point.volume,
    });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-40);
}
