const POSLEY_GATEWAY = process.env.NEXT_PUBLIC_REDIS_BACKEND_URL?.trim() || "https://redis-data.posley.capital";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN?.trim() || "posley.auth.us-east-1.amazoncognito.com";
const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID?.trim() || "5qup0una5tdma3l33pnn1gm87i";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const RECONNECT_BACKOFF_MS = 3_000;
const MAX_SYMBOLS = 24;

export type PosleyAdrBook = {
  symbol: string;
  streamKey: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  timestamp: number;
};

type FeedState = "idle" | "connecting" | "live" | "partial" | "reconnecting" | "unconfigured";

type SharedState = {
  books: Map<string, PosleyAdrBook>;
  wanted: Set<string>;
  streamBySymbol: Map<string, string>;
  token: string | null;
  tokenExpiresAt: number;
  socket: WebSocket | null;
  connectPromise: Promise<void> | null;
  state: FeedState;
  error: string;
  retryAfter: number;
  generation: number;
};

type PosleyGlobal = typeof globalThis & { __POSLEY_ADR_FEED__?: SharedState };

const shared = () => {
  const root = globalThis as PosleyGlobal;
  root.__POSLEY_ADR_FEED__ ??= {
    books: new Map(),
    wanted: new Set(),
    streamBySymbol: new Map(),
    token: null,
    tokenExpiresAt: 0,
    socket: null,
    connectPromise: null,
    state: "idle",
    error: "",
    retryAfter: 0,
    generation: 0,
  };
  return root.__POSLEY_ADR_FEED__;
};

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parseLevels = (value?: string) => !value ? [] : value.split("|").flatMap((level) => {
  const [priceRaw, sizeRaw] = level.split(",");
  const price = Number(priceRaw);
  const size = Number(sizeRaw);
  return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0 ? [{ price, size }] : [];
});

const marketTimestamp = (data: Record<string, string>) => {
  const values = [data.last_tick_ts_ms, data.bids_receive_ts_ms, data.asks_receive_ts_ms, data.event_emit_ts_ms]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : Date.now();
};

const normalizeSymbols = (symbols: string[]) => [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase())
  .filter((symbol) => /^[A-Z0-9.]{1,16}$/.test(symbol)))].slice(0, MAX_SYMBOLS);

const symbolForStream = (streamKey: string, symbols: Set<string>) => {
  const [category, venue, ...codeParts] = streamKey.toUpperCase().split(":");
  if (category !== "ORDERBOOK" || !["IBKR", "FUTU"].includes(venue)) return null;
  const code = codeParts.join(":");
  return [...symbols].find((symbol) => codeParts.includes(symbol) || code === symbol || code === `US.${symbol}` || code.endsWith(`.${symbol}`)) ?? null;
};

const jwtExpiry = (token: string) => {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)))) as { exp?: number };
    return Number(decoded.exp) * 1_000 || Date.now() + 55 * 60_000;
  } catch {
    return Date.now() + 55 * 60_000;
  }
};

async function freshIdToken(state: SharedState) {
  if (state.token && state.tokenExpiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return state.token;
  const refreshToken = process.env.POSLEY_REFRESH_TOKEN?.trim();
  if (!refreshToken) throw new Error("POSLEY_REFRESH_TOKEN is not configured.");
  const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: COGNITO_CLIENT_ID, refresh_token: refreshToken }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Posley token refresh HTTP ${response.status}`);
  const payload = await response.json() as { id_token?: string; expires_in?: number };
  if (!payload.id_token) throw new Error("Posley token refresh returned no ID token.");
  state.token = payload.id_token;
  state.tokenExpiresAt = jwtExpiry(payload.id_token);
  return payload.id_token;
}

async function streamDirectory(token: string) {
  const gateway = new URL(POSLEY_GATEWAY);
  if (gateway.protocol !== "https:") throw new Error("Posley gateway must use HTTPS.");
  const response = await fetch(new URL("/redis/streams", gateway), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Posley stream directory HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(payload) ? payload : Array.isArray(record.streamKeys) ? record.streamKeys : Array.isArray(record.keys) ? record.keys : [];
  return raw.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string" ? [String((item as { key: string }).key)] : []);
}

function closeSocket(state: SharedState) {
  const socket = state.socket;
  state.socket = null;
  state.generation += 1;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function acceptBook(state: SharedState, streamKey: string, data: Record<string, string>) {
  const symbol = [...state.streamBySymbol.entries()].find(([, key]) => key === streamKey)?.[0];
  if (!symbol) return;
  const bids = parseLevels(data.bids);
  const asks = parseLevels(data.asks);
  const last = positive(data.last_price);
  if (!bids.length && !asks.length && last === null) return;
  state.books.set(symbol, {
    symbol,
    streamKey,
    bid: bids[0]?.price ?? null,
    ask: asks[0]?.price ?? null,
    last,
    bidSize: bids[0]?.size ?? null,
    askSize: asks[0]?.size ?? null,
    timestamp: marketTimestamp(data),
  });
  state.state = state.streamBySymbol.size === state.wanted.size ? "live" : "partial";
  state.error = "";
}

async function connect(state: SharedState) {
  state.state = "connecting";
  state.error = "";
  const token = await freshIdToken(state);
  const keys = await streamDirectory(token);
  const wanted = new Set(state.wanted);
  state.streamBySymbol.clear();
  for (const key of keys) {
    const symbol = symbolForStream(key, wanted);
    if (symbol && !state.streamBySymbol.has(symbol)) state.streamBySymbol.set(symbol, key);
  }
  if (!state.streamBySymbol.size) {
    state.state = "partial";
    state.error = "No matching live ADR stream is currently published by Posley.";
    state.retryAfter = Date.now() + 15_000;
    return;
  }

  const url = new URL("/socket.io/", POSLEY_GATEWAY);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "EIO=4&transport=websocket";
  const socket = new WebSocket(url);
  const generation = ++state.generation;
  state.socket = socket;

  socket.onopen = () => socket.send(`40${JSON.stringify({ token })}`);
  socket.onmessage = (message) => {
    if (generation !== state.generation) return;
    const frame = String(message.data);
    if (frame === "2") return socket.send("3");
    if (frame.startsWith("40")) {
      state.streamBySymbol.forEach((streamKey) => socket.send(`42${JSON.stringify(["stream:subscribe", { streamKey, region: "tokyo" }])}`));
      return;
    }
    if (!frame.startsWith("42")) return;
    try {
      const [eventName, event] = JSON.parse(frame.slice(2)) as [string, { streamKey?: string; entries?: Array<{ data?: Record<string, string> }> }];
      if (eventName !== "stream:data" || !event.streamKey) return;
      const data = event.entries?.at(-1)?.data;
      if (data) acceptBook(state, event.streamKey, data);
    } catch { /* Ignore malformed gateway frames. */ }
  };
  const disconnected = () => {
    if (generation !== state.generation) return;
    state.socket = null;
    state.state = "reconnecting";
    state.error = "Posley ADR feed is reconnecting.";
    state.retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
  };
  socket.onerror = disconnected;
  socket.onclose = disconnected;
}

async function ensureConnection(state: SharedState, symbols: string[]) {
  const before = [...state.wanted].sort().join(",");
  symbols.forEach((symbol) => state.wanted.add(symbol));
  const after = [...state.wanted].sort().join(",");
  const needsFreshConnection = before !== after || !state.socket || state.tokenExpiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS;
  if (!needsFreshConnection || state.connectPromise || Date.now() < state.retryAfter) return;
  if (state.socket) closeSocket(state);
  state.connectPromise = connect(state).catch((error) => {
    state.state = "reconnecting";
    state.error = error instanceof Error ? error.message : "Posley ADR feed unavailable.";
    state.retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
  }).finally(() => { state.connectPromise = null; });
  await state.connectPromise;
}

export async function posleyAdrSnapshot(requestedSymbols: string[]) {
  const symbols = normalizeSymbols(requestedSymbols);
  const refreshToken = process.env.POSLEY_REFRESH_TOKEN?.trim();
  const state = shared();
  if (!refreshToken) {
    state.state = "unconfigured";
    return { configured: false, state: state.state, error: "Server-side Posley ADR access is not configured.", books: [], missing: symbols, timestamp: Date.now() };
  }
  await ensureConnection(state, symbols);
  const books = symbols.flatMap((symbol) => {
    const book = state.books.get(symbol);
    return book ? [book] : [];
  });
  const missing = symbols.filter((symbol) => !state.streamBySymbol.has(symbol));
  return { configured: true, state: state.state, error: state.error, books, missing, timestamp: Date.now() };
}
