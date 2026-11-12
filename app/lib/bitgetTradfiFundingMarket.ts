import { parseTradfiFunding, parseTradfiInstruments, fundingSnapshotFresh } from "./bitgetTradfiFunding";
import type { BitgetTradfiInstrument, TradfiFundingSnapshot } from "./bitgetTradfiFunding";

const API = "https://api.bitget.com/api/v3/market";
const REFRESH_MS = 15_000;
const UNIVERSE_REFRESH_MS = 15 * 60_000;
type FundingStore = {
  instruments?: { rows: BitgetTradfiInstrument[]; timestamp: number };
  snapshot?: TradfiFundingSnapshot;
  lastAttempt?: number;
  lastError?: string;
  pending?: Promise<TradfiFundingSnapshot>;
};
type FundingGlobal = typeof globalThis & { __BITGET_TRADFI_FUNDING__?: FundingStore };

async function bitget(endpoint: "instruments" | "current-fund-rate") {
  const response = await fetch(`${API}/${endpoint}?category=USDT-FUTURES`, {
    cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Bitget market data is temporarily unavailable.");
  return response.json() as Promise<unknown>;
}

export async function bitgetTradfiFundingState(): Promise<TradfiFundingSnapshot> {
  const global = globalThis as FundingGlobal;
  const store = global.__BITGET_TRADFI_FUNDING__ ??= {};
  const now = Date.now();
  const retained = (): TradfiFundingSnapshot => {
    if (!store.snapshot) throw new Error(store.lastError ?? "Bitget funding rates are temporarily unavailable.");
    return { ...store.snapshot, stale: Boolean(store.lastError) || !fundingSnapshotFresh(store.snapshot, Date.now()), error: store.lastError ?? null };
  };
  if (store.pending) return store.pending;
  if (store.lastAttempt !== undefined && now - store.lastAttempt < REFRESH_MS) return retained();
  store.lastAttempt = now;
  store.pending = (async () => {
    try {
      const cachedUniverse = store.instruments && now - store.instruments.timestamp < UNIVERSE_REFRESH_MS ? store.instruments : null;
      const [universe, rates] = await Promise.all([
        cachedUniverse ? Promise.resolve(cachedUniverse) : bitget("instruments").then(payload => ({ rows: parseTradfiInstruments(payload), timestamp: Date.now() })),
        bitget("current-fund-rate"),
      ]);
      const snapshot = parseTradfiFunding(universe.rows, rates, Date.now(), universe.timestamp);
      store.instruments = universe;
      store.snapshot = snapshot;
      delete store.lastError;
      return snapshot;
    } catch {
      store.lastError = "Bitget could not refresh. The last snapshot and its original time are retained.";
      return retained();
    } finally { delete store.pending; }
  })();
  return store.pending;
}
