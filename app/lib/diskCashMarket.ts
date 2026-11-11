import { bitgetBooksWithin, bitgetMidpoint, bitgetTradedMinuteClose } from "./bitgetRelativeMarket";
import {
  diskCashSnapshot, latestDiskCashClose, latestDramMinute, readEtfChart, regularEtfClose,
  type DiskBook, type DiskCashAnchor, type DramReference,
} from "./diskCashModel";
import { posleyAdrSnapshot } from "./posleyAdr";
import { getDiskConstituentSnapshot } from "./diskConstituentMarket";

type Cache<T> = { value: T | null; retryAt: number; pending?: Promise<T | null> };
const cache = <T>(): Cache<T> => ({ value: null, retryAt: 0 });

function cached<T>(slot: Cache<T>, ttl: number, load: () => Promise<T | null>) {
  if (slot.pending) return slot.pending;
  if (Date.now() < slot.retryAt) return Promise.resolve(slot.value);
  slot.pending = load().catch(() => null).then((value) => {
    slot.value = value;
    slot.retryAt = Date.now() + (value === null ? 25_000 : ttl);
    return value;
  }).finally(() => { delete slot.pending; });
  return slot.pending;
}

function within<T>(work: Promise<T>, ms: number) {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); });
  });
}

type EtfChart = NonNullable<ReturnType<typeof readEtfChart>>;
async function yahoo<T>(symbol: "DISK" | "DRAM", query: string, parse: (chart: EtfChart) => T | null) {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetch(`https://${host}/v8/finance/chart/${symbol}?${query}`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        cache: "no-store", signal: AbortSignal.timeout(2_200),
      });
      if (!response.ok) continue;
      const chart = readEtfChart(await response.json(), symbol);
      const value = chart ? parse(chart) : null;
      if (value !== null) return value;
    } catch { /* The second Yahoo host can supply the same timestamped series. */ }
  }
  return null;
}

let closeCache = { at: 0, cash: cache<DiskCashAnchor>(), perp: cache<number>() };
const dramBar = cache<{ price: number; at: number }>();
const dramGatewayBook = cache<DiskBook>();

type OfficeQuotes = {
  __FUTU_PUSH_SNAPSHOT__?: {
    receivedAt: number;
    payload: { quotes?: Array<{ symbol?: string; bid?: number | null; ask?: number | null; marketTimestamp?: number | null }> };
  };
};

function cashBook(bid: number | null | undefined, ask: number | null | undefined, at: number, now: number) {
  if (typeof bid !== "number" || typeof ask !== "number" ||
      ![bid, ask, at].every(Number.isFinite) || bid <= 0 || ask < bid || at <= 0 ||
      now - at > 30_000 || at - now > 5_000) return null;
  return { bid, ask, mid: (bid + ask) / 2, at };
}

async function futuDramBook() {
  const now = Date.now();
  const push = (globalThis as typeof globalThis & OfficeQuotes).__FUTU_PUSH_SNAPSHOT__;
  const quote = push?.payload.quotes?.find((record) => record.symbol === "US.DRAM");
  const office = push && now - push.receivedAt <= 30_000 && quote
    ? cashBook(quote.bid, quote.ask, Number(quote.marketTimestamp), now) : null;
  if (office) return office;

  const book = await cached(dramGatewayBook, 2_000, async () => {
    const remote = await within(posleyAdrSnapshot(["DRAM"]), 1_500);
    const quote = remote?.books.find((record) =>
      record.streamKey === "orderbook:futu:US.DRAM" ||
      record.streamKey === "orderbook:futu:web_api:US.DRAM");
    return quote ? cashBook(quote.bid, quote.ask, quote.timestamp, Date.now()) : null;
  });
  return book ? cashBook(book.bid, book.ask, book.at, Date.now()) : null;
}

async function cashAnchor(session: { date: string; at: number }) {
  const close = (symbol: "DISK" | "DRAM") => yahoo(symbol, "range=5d&interval=1d",
    (chart) => regularEtfClose(chart, session.date, session.at));
  const [disk, dram] = await Promise.all([close("DISK"), close("DRAM")]);
  return disk !== null && dram !== null ? { ...session, disk, dram } : null;
}

export async function getDiskCashModel() {
  const session = latestDiskCashClose(Date.now());
  if (!session) return diskCashSnapshot(Date.now(), null, null, null);
  if (closeCache.at !== session.at) closeCache = { at: session.at, cash: cache(), perp: cache() };
  const slot = closeCache;
  const [anchor, books, futu] = await Promise.all([
    cached(slot.cash, 60 * 60_000, () => cashAnchor(session)),
    bitgetBooksWithin(4_000).catch(() => []),
    futuDramBook(),
  ]);

  let reference: DramReference | null = null;
  if (anchor) {
    if (futu && futu.at >= anchor.at && cashBook(futu.bid, futu.ask, futu.at, Date.now())) {
      reference = { source: "futu", price: futu.mid, base: anchor.dram, at: futu.at };
    } else {
      const minute = await cached(dramBar, 45_000, () => yahoo("DRAM", "range=1d&interval=1m&includePrePost=true",
        (chart) => latestDramMinute(chart, Date.now(), anchor.at)));
      if (minute && minute.at >= anchor.at && Date.now() - minute.at <= 180_000) {
        reference = { ...minute, source: "yahoo", base: anchor.dram };
      } else {
        const quote = books.find((item) => item.symbol === "DRAMUSDT");
        const close = await within(cached(slot.perp, 12 * 60 * 60_000,
          () => bitgetTradedMinuteClose("DRAMUSDT", anchor.at)), 3_000);
        const mid = bitgetMidpoint(quote);
        if (close && mid) reference = { source: "bitget", price: mid, base: close, at: Number(quote?.ts) };
      }
    }
  }
  const quote = books.find((item) => item.symbol === "DISKUSDT");
  const mid = bitgetMidpoint(quote);
  const book = mid ? { mid, bid: Number(quote?.bidPr), ask: Number(quote?.askPr), at: Number(quote?.ts) } : null;
  const constituents = getDiskConstituentSnapshot(session);
  return diskCashSnapshot(Date.now(), anchor, book, reference, constituents);
}
