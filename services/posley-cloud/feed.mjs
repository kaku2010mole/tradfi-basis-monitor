import { registry, symbols, decode } from "./registry.mjs";

export function createFeed({ auth, createTransport, clock = Date.now, publish = async () => {} }) {
  const books = new Map(), history = new Map();
  let transports = [], activeToken = null, generation = 0, renewing = false, publishing = false;
  let messages = 0, lastMessageAt = null, lastPublishedAt = null, error = "", retryAt = 0, startedAt = clock();
  let timer, pushTimer;
  function receive(message) {
    if (!registry.has(message?.streamKey) || !Array.isArray(message.entries)) return;
    messages++; lastMessageAt = clock();
    for (const entry of message.entries.slice(-20)) {
      const quote = decode(message.streamKey, entry.data, clock());
      if (!quote) continue;
      const old = books.get(quote.symbol);
      // Prefer a fresh executable FX book over an indicative index heartbeat.
      if (old?.bid && old.ask && clock() - old.timestamp < 60_000 && !quote.bid && !quote.ask) continue;
      if (old && old.timestamp > quote.timestamp) continue;
      books.set(quote.symbol, quote);
      if (quote.symbol === "USDKRW") {
        const value = quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : quote.last;
        if (value && clock() - quote.timestamp < 60_000) history.set(Math.floor(quote.timestamp / 60_000) * 60_000, value);
        while (history.size > 2500) history.delete(history.keys().next().value);
      }
    }
  }
  async function tick() {
    if (renewing || clock() < retryAt) return;
    renewing = true;
    try {
      const token = await auth.token();
      if (!token) return;
      if (token === activeToken && transports.length && transports.every(item => clock() - item.lastWireAt < 120_000)) return;
      generation++;
      const current = generation;
      for (const item of transports) item.client.close();
      transports = []; activeToken = token;
      const keys = [...registry.keys()];
      for (let offset = 0; offset < keys.length; offset += 20) {
        const client = await createTransport({ transport: "remote", env: {}, idToken: token, logger: () => {} });
        const item = { client, state: "connecting", lastWireAt: clock() };
        transports.push(item);
        client.on("status", status => { if (generation === current) item.state = status.state; });
        client.on("error", () => { if (generation === current) error = "Some market streams were rejected. Missing symbols are listed separately."; });
        client.on("data", message => { if (generation === current) { item.lastWireAt = clock(); receive(message); } });
        await client.subscribe(keys.slice(offset, offset + 20));
      }
      error = "";
    } catch {
      // Never log upstream errors: gateways may echo authentication input.
      error = auth.status().error || "Posley cloud connection is retrying.";
      activeToken = null;
      retryAt = clock() + 30_000;
    } finally { renewing = false; }
  }
  function snapshot(wanted = symbols) {
    const selected = [...new Set(wanted)].filter(symbol => symbols.includes(symbol));
    const rows = selected.flatMap(symbol => books.has(symbol) ? [books.get(symbol)] : []);
    const missing = selected.filter(symbol => !books.has(symbol));
    const connected = transports.filter(item => item.state === "connected").length;
    return { configured: auth.status().authorized, state: !auth.status().authorized ? "unconfigured" : !connected ? "reconnecting" : missing.length ? "partial" : "live",
      error: auth.status().error || error, books: rows, missing, timestamp: clock(), source: "Posley cloud gateway" };
  }
  function status() {
    return { ...auth.status(), source: "Posley cloud gateway", runningOn: "Render", storage: "Render persistent disk only",
      startedAt, messages, lastMessageAt, lastPublishedAt, connections: transports.map(item => item.state),
      receivedSymbols: [...books.keys()], missingSymbols: symbols.filter(symbol => !books.has(symbol)),
      quoteTimes: Object.fromEntries([...books].map(([symbol, book]) => [symbol, book.timestamp])),
      error: auth.status().error || error };
  }
  async function push() {
    if (publishing || !books.size) return;
    publishing = true;
    try {
      const quotes = [...books.values()].map(book => {
        const prefix = book.symbol.startsWith("USD") ? "FX." : /^\d{6}$/.test(book.symbol) ? "KRX." : /^\d{3}[A-Z0-9]$/.test(book.symbol) ? "TSE." : "US.";
        return { ...book, symbol: prefix + book.symbol, marketTimestamp: book.timestamp,
          marketState: prefix === "FX." ? "FX_REFERENCE" : prefix === "KRX." ? "KRX_REFERENCE" : prefix === "TSE." ? "TSE_REFERENCE" : null };
      });
      await publish({ generatedAt: clock(), quotes, history: history.size ? { "FX.USDKRW": [...history].sort((a, b) => a[0] - b[0]) } : undefined });
      lastPublishedAt = clock();
    } catch { error = "Cloud quotes received; dashboard delivery is retrying."; }
    finally { publishing = false; }
  }
  return { tick, push, receive, snapshot, status,
    start() { void tick(); timer = setInterval(() => void tick(), 10_000); pushTimer = setInterval(() => void push(), 2_000); },
    stop() { clearInterval(timer); clearInterval(pushTimer); generation++; for (const item of transports) item.client.close(); transports = []; },
  };
}
