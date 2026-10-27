import { alignedSmicRows, smicGroups, trainingRows } from "./smicOpening";
import type { SmicBar, SmicGroup, SmicRow } from "./smicOpening";

export type PeerAsset = "zhongji" | "gigadev";
export const PEER_ASSETS = {
  zhongji: { name: "ZHONGJI", chinese: "中际旭创", code: "03308.HK", yahoo: "3308.HK", peer: "LITE", listed: "2026-07-30", minTraining: 30 },
  gigadev: { name: "GIGADEV", chinese: "兆易创新", code: "03986.HK", yahoo: "3986.HK", peer: "MU", listed: "2026-01-13", minTraining: 60 },
} as const;
export const isPeerAsset = (value: unknown): value is PeerAsset => value === "zhongji" || value === "gigadev";
export type PeerRow = SmicRow & { peerReturn: number };
export type PeerModel = { n: number; start: string; end: string; intercept: number; smhBeta: number; peerBeta: number; r2: number; minSmh: number; maxSmh: number; minPeer: number; maxPeer: number };
export type PeerJointGroup = SmicGroup & { smhIndex: number; peerIndex: number; smhLabel: string; peerLabel: string };
export const PEER_GROUP_LABELS = ["< −4%", "−4% to −2%", "−2% to 0%", "0% to +2%", "+2% to +4%", "≥ +4%"];
export const PEER_GROUP_EXAMPLES = [-5, -3, -1, 1, 3, 5];
export const peerGroupIndex = (x: number) => !Number.isFinite(x) ? -1 : x < -4 ? 0 : x >= 4 ? 5 : Math.floor(x / 2) + 3;
export const peerJointIndex = (x: number, boundary: number) => x < -boundary ? 0 : x >= boundary ? 2 : 1;
const SMH_JOINT_LABELS = ["< −1%", "−1% to +1%", "≥ +1%"];
const PEER_JOINT_LABELS = ["< −2%", "−2% to +2%", "≥ +2%"];

export function alignedPeerRows(hk: SmicBar[], smh: SmicBar[], peer: SmicBar[], now: number, asset: PeerAsset): PeerRow[] {
  const peerByDate = new Map(peer.map(bar => [bar.date, bar]));
  // Clip before calculating previous-close returns: a reused HK code must never
  // contribute history belonging to an earlier issuer or an IPO first-day gap.
  return alignedSmicRows(hk.filter(bar => bar.date >= PEER_ASSETS[asset].listed), smh, now).flatMap(row => {
    const bar = peerByDate.get(row.usDate);
    return bar?.complete && bar.open > 0 && bar.close > 0 ? [{ ...row, peerReturn: 100 * (bar.close / bar.open - 1) }] : [];
  });
}
export const peerTraining = (rows: PeerRow[], target: string) => trainingRows(rows, target).filter(row => Number.isFinite((row as PeerRow).peerReturn)) as PeerRow[];

export function fitPeer(rows: PeerRow[], asset: PeerAsset): PeerModel | null {
  const n = rows.length;
  if (n < PEER_ASSETS[asset].minTraining) return null;
  const mean = (f: (r: PeerRow) => number) => rows.reduce((sum, r) => sum + f(r), 0) / n;
  const sx = mean(r => r.smhReturn), px = mean(r => r.peerReturn), y = mean(r => r.gap);
  let ss = 0, pp = 0, sp = 0, sy = 0, py = 0;
  for (const r of rows) {
    const a = r.smhReturn - sx, b = r.peerReturn - px, c = r.gap - y;
    ss += a * a; pp += b * b; sp += a * b; sy += a * c; py += b * c;
  }
  const determinant = ss * pp - sp * sp;
  if (determinant <= 1e-10 * Math.max(1, ss * pp)) return null;
  const smhBeta = (sy * pp - py * sp) / determinant, peerBeta = (py * ss - sy * sp) / determinant;
  const intercept = y - smhBeta * sx - peerBeta * px;
  const sse = rows.reduce((sum, r) => sum + (r.gap - intercept - smhBeta * r.smhReturn - peerBeta * r.peerReturn) ** 2, 0);
  const sst = rows.reduce((sum, r) => sum + (r.gap - y) ** 2, 0);
  return { n, start: rows[0].date, end: rows[n - 1].date, intercept, smhBeta, peerBeta, r2: sst > 0 ? 1 - sse / sst : 0,
    minSmh: Math.min(...rows.map(r => r.smhReturn)), maxSmh: Math.max(...rows.map(r => r.smhReturn)),
    minPeer: Math.min(...rows.map(r => r.peerReturn)), maxPeer: Math.max(...rows.map(r => r.peerReturn)) };
}

function distribution(rows: PeerRow[]) {
  return smicGroups(rows.map(row => ({ ...row, smhReturn: 0 })))[4];
}
export function peerMarginalGroups(rows: PeerRow[], factor: "smhReturn" | "peerReturn"): SmicGroup[] {
  return PEER_GROUP_LABELS.map((label, index) => ({ ...distribution(rows.filter(row => peerGroupIndex(row[factor]) === index)), label, index }));
}
export function peerJointGroups(rows: PeerRow[], peer: string): PeerJointGroup[] {
  return SMH_JOINT_LABELS.flatMap((smhLabel, smhIndex) => PEER_JOINT_LABELS.map((peerLabel, peerIndex) => ({
    ...distribution(rows.filter(row => peerJointIndex(row.smhReturn, 1) === smhIndex && peerJointIndex(row.peerReturn, 2) === peerIndex)),
    index: smhIndex * 3 + peerIndex, label: `SMH ${smhLabel} · ${peer} ${peerLabel}`, smhIndex, peerIndex, smhLabel, peerLabel,
  })));
}
export function peerEstimate(model: PeerModel | null, groups: PeerJointGroup[], smh: number | null, peer: number | null) {
  if (!model || smh === null || peer === null || !Number.isFinite(smh) || !Number.isFinite(peer)) return null;
  return { gap: model.intercept + model.smhBeta * smh + model.peerBeta * peer,
    group: groups[peerJointIndex(smh, 1) * 3 + peerJointIndex(peer, 2)],
    extrapolated: smh < model.minSmh || smh > model.maxSmh || peer < model.minPeer || peer > model.maxPeer };
}
export function peerStudy(rows: PeerRow[], target: string, asset: PeerAsset) {
  const training = peerTraining(rows, target), model = fitPeer(training, asset);
  const predictions = training.flatMap(row => {
    const m = fitPeer(peerTraining(rows, row.date), asset);
    return m ? [{ date: row.date, actual: row.gap, predicted: m.intercept + m.smhBeta * row.smhReturn + m.peerBeta * row.peerReturn }] : [];
  });
  const n = predictions.length, nonflat = predictions.filter(row => row.actual !== 0);
  const hits = nonflat.filter(row => Math.sign(row.actual) === Math.sign(row.predicted)).length;
  return { model, groups: peerJointGroups(training, PEER_ASSETS[asset].peer), smhGroups: peerMarginalGroups(training, "smhReturn"), peerGroups: peerMarginalGroups(training, "peerReturn"),
    backtest: { n, nonflat: nonflat.length, hits, start: predictions[0]?.date ?? null, end: predictions.at(-1)?.date ?? null,
      mae: n ? predictions.reduce((sum, row) => sum + Math.abs(row.actual - row.predicted), 0) / n : null,
      accuracy: nonflat.length ? 100 * hits / nonflat.length : null, recent: predictions.slice(-10).reverse() } };
}
