export type KoreanCloseReference = { price: number; source: string; observedAt: number; sessionDate: string };
export type KrwConversionRate = { rate: number | null; source: string; date: string | null; updatedAt: number | null; live: boolean };

const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
export const koreanDate = (timestamp: number) => dateFormat.format(timestamp);
const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// Display-only conversion. FX midpoint/reference, never an executable cash edge.
export function koreanPerpKrw(bid: number | null, ask: number | null, sharesPerPerp: number, rate: number | null, previousClose: number | null) {
  const validScale = positive(sharesPerPerp) && positive(rate);
  const bidKrw = validScale && positive(bid) ? bid * rate / sharesPerPerp : null;
  const askKrw = validScale && positive(ask) ? ask * rate / sharesPerPerp : null;
  // A missing side or crossed book cannot produce a midpoint.
  const midpointKrw = bidKrw !== null && askKrw !== null && bidKrw <= askKrw ? (bidKrw + askKrw) / 2 : null;
  const change = (price: number | null) => price !== null && positive(previousClose) ? (price / previousClose - 1) * 100 : null;
  return { bidKrw, askKrw, midpointKrw, bidChangePct: change(bidKrw), askChangePct: change(askKrw), midpointChangePct: change(midpointKrw) };
}
