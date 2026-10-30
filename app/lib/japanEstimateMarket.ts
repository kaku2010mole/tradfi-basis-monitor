import seed from "./data/japanCashSeed.json";
import { JAPAN_ESTIMATE_STOCKS, cashEstimate, fitCashModel, freshRealQuote, japanCloseTime, japanDate, latestJapanClose, parseJapanHistory, realQuote } from "./japanEstimate";
import type { CashHistory, CashModel, RealQuote } from "./japanEstimate";
import { posleyAdrSnapshot } from "./posleyAdr";
import { bitgetBooksWithin, bitgetMidpoint } from "./bitgetRelativeMarket";
import { japanSpotFx } from "./japanSpotFx";
import { kioxiaPtsCash } from "./japanPtsCash";

type Entry = { history: CashHistory; refreshAt: number; checkedTarget: string | null; pending?: Promise<void>; error?: string };
type State = { entries: Map<string, Entry>; models: Map<string, { key: string; value: CashModel | null }>; kioxia: RealQuote | null; fx: RealQuote | null };
type Root = typeof globalThis & { __JAPAN_ESTIMATE__?: State; __FUTU_PUSH_SNAPSHOT__?: { payload: { quotes: Record<string, unknown>[] }; receivedAt: number } };
const root = globalThis as Root;
const codes = ["285A", ...JAPAN_ESTIMATE_STOCKS.map(s => s.code)];
function state(): State {
  return root.__JAPAN_ESTIMATE__ ??= {
    entries: new Map(Object.entries(seed.histories).map(([code, history]) => [code, { history, refreshAt: 0, checkedTarget: null }])),
    models: new Map(), kioxia: null, fx: null,
  };
}
let active = 0;
const queue: Array<() => void> = [];
async function limited(run: () => Promise<void>) {
  if (active >= 3) await new Promise<void>(resolve => queue.push(resolve)); else active++;
  try { await run(); } finally { const next = queue.shift(); if (next) next(); else active--; }
}
function refreshCloses(store: State, target: string | null, now: number) {
  if (!target) return;
  for (const code of codes) {
    const entry = store.entries.get(code)!;
    if (entry.pending || entry.checkedTarget === target && entry.refreshAt > now) continue;
    entry.checkedTarget = target;
    entry.pending = Promise.resolve().then(() => limited(async () => {
      try {
        const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=1y&interval=1d&events=div%2Csplits`, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error("Cash history unavailable");
        const next = parseJapanHistory(await response.json(), code, Date.now());
        if (!next || next.bars.at(-1)!.date < entry.history.bars.at(-1)!.date) throw new Error("Cash close not yet published");
        entry.history = next;
        entry.error = undefined;
      } catch { entry.error = "现货收盘数据刷新失败；保留原始日期"; }
      finally {
        entry.refreshAt = Date.now() + (entry.error || entry.history.bars.at(-1)?.date !== latestJapanClose(Date.now()) ? 60_000 : 20 * 60_000);
        entry.pending = undefined;
      }
    }));
  }
}
const best = (quotes: Array<RealQuote | null>) => quotes.filter((q): q is RealQuote => q !== null).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
function timeBound<T>(promise: Promise<T>, timeout: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeout);
    promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}
export async function japanEstimateState(token?: string, now = Date.now()) {
  const store = state(), anchorDate = latestJapanClose(now);
  refreshCloses(store, anchorDate, now);
  const office = root.__FUTU_PUSH_SNAPSHOT__?.payload.quotes ?? [];
  const officeQuote = (symbol: string) => {
    const record = office.find(q => q.symbol === symbol);
    return realQuote(record, typeof record?.source === "string" ? record.source : "Posley 现货行情", now);
  };
  const officeK = officeQuote("TSE.285A"), officeFx = officeQuote("FX.USDJPY");
  // Shared connection is optional when the office relay already supplies both inputs.
  const remote = freshRealQuote(officeK, now) && freshRealQuote(officeFx, now) ? [] : (await timeBound(posleyAdrSnapshot(["285A", "USDJPY"], token).then(s => s.books), 1800, []) );
  const remoteQuote = (symbol: string) => {
    const q = remote.find(q => q.symbol === symbol);
    // Explicit allowlist prevents an identically named derivative from entering.
    const validStream = symbol === "285A" ? /^orderbook:ibkr:STK:285A:TSEJ:JPY$/i.test(q?.streamKey ?? "") : /^orderbook:ibkr:FX:USD:JPY$/i.test(q?.streamKey ?? "");
    return validStream ? realQuote(q as unknown as Record<string, unknown>, "Posley IBKR · 真实股票 / 外汇", now) : null;
  };
  store.kioxia = best([officeK, remoteQuote("285A"), store.kioxia && store.kioxia.timestamp <= now + 5000 ? store.kioxia : null,
    !freshRealQuote(officeK, now) && !freshRealQuote(remoteQuote("285A"), now) ? kioxiaPtsCash(now) : null]);
  store.fx = best([officeFx, remoteQuote("USDJPY"), store.fx && store.fx.timestamp <= now + 5000 && now - store.fx.timestamp <= 7 * 86_400_000 ? store.fx : null,
    !freshRealQuote(officeFx, now) && !freshRealQuote(remoteQuote("USDJPY"), now) ? japanSpotFx(now) : null]);
  const kHistory = store.entries.get("285A")!.history;
  const kAnchor = anchorDate ? kHistory.bars.find(b => b.date === anchorDate)?.close ?? null : null;
  const anchorTime = anchorDate ? japanCloseTime(anchorDate) : null;
  const splitSinceAnchor = (history: CashHistory) => Boolean(anchorDate && history.splits.some(d => d > anchorDate && d <= japanDate(now)));
  const kQuote = store.kioxia && anchorTime && store.kioxia.timestamp >= anchorTime && !splitSinceAnchor(kHistory) ? store.kioxia : null;
  const kPrice = kQuote?.price ?? kAnchor;
  const kFresh = freshRealQuote(kQuote, now);
  const fx = store.fx, fxFresh = freshRealQuote(fx, now);
  const kReturn = kAnchor && kPrice ? (kPrice / kAnchor - 1) * 100 : null;
  const rows = JAPAN_ESTIMATE_STOCKS.map(stock => {
    const entry = store.entries.get(stock.code)!, history = entry.history;
    const close = anchorDate ? history.bars.find(b => b.date === anchorDate)?.close ?? null : null;
    const key = `${kHistory.fetchedAt}:${history.fetchedAt}:${anchorDate}`;
    let calibration = store.models.get(stock.code);
    if (!calibration || calibration.key !== key) {
      calibration = { key, value: anchorDate ? fitCashModel(kHistory.bars, history.bars, anchorDate) : null };
      store.models.set(stock.code, calibration);
    }
    const model = calibration.value;
    const rebase = splitSinceAnchor(history) || splitSinceAnchor(kHistory);
    const yen = close && kAnchor && kPrice && model && !rebase ? cashEstimate(close, kAnchor, kPrice, model.beta) : null;
    const usd = yen && fx ? yen / fx.price : null;
    return { ...stock, close, yen, usd, changePct: yen && close ? (yen / close - 1) * 100 : null, model,
      weak: !model || Math.abs(model.correlation) < 0.4 || (model.improvementPct ?? -1) <= 0,
      status: !anchorDate ? "交易日历待更新" : !close || !kAnchor ? "等待本次收盘价" : rebase ? "拆股日：等待新收盘锚点" : !model ? "历史样本不足" : !kQuote ? "收盘参考" : kFresh ? "现货驱动外推" : kQuote.delayMinutes && now - kQuote.timestamp <= 35 * 60_000 ? "延迟现货外推" : "估价已冻结",
      historyDate: history.bars.at(-1)?.date ?? null, historyFetchedAt: history.fetchedAt, historyError: entry.error ?? null,
    };
  });
  // Contract quotes enter only here, after every cash estimate is complete.
  const contracts = await bitgetBooksWithin(2500).catch(() => []);
  const comparisonNow = Date.now();
  const compared = rows.map(row => {
    const book = contracts.find(q => q.symbol === row.symbol);
    const mid = bitgetMidpoint(book, comparisonNow);
    const comparable = Boolean(mid && Number(book?.bidSz) > 0 && Number(book?.askSz) > 0 && row.usd && freshRealQuote(kQuote, comparisonNow) && freshRealQuote(fx, comparisonNow));
    return { ...row, contract: book ? { bid: Number(book.bidPr) || null, ask: Number(book.askPr) || null, timestamp: Number(book.ts) || null } : null,
      deviationPct: comparable && mid && row.usd ? (mid / row.usd - 1) * 100 : null };
  });
  return { timestamp: comparisonNow, anchorDate, anchorTime, anchorReady: Boolean(kAnchor && rows.every(r => r.close)),
    kioxia: { anchor: kAnchor, quote: kQuote, price: kPrice, changePct: kReturn, fresh: kFresh },
    fx: { quote: fx, fresh: fxFresh }, rows: compared,
    historySource: "Yahoo Finance · TSE 真实股票日线", modelDefinition: "close-anchored-cash-log-return-v1", calendarThrough: "2027-12-31" };
}
export type JapanEstimatePayload = Awaited<ReturnType<typeof japanEstimateState>>;
