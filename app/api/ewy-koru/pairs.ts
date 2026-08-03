export type PairMode = "returns" | "ratio" | "oracle";

export type ApiPair = {
  id: string;
  base: string;
  leveraged: string;
  factor: number;
  mode: PairMode;
  priceRatio?: number;
};

const BUILTIN_PAIRS: Record<string, ApiPair> = {
  "ewy-koru": { id: "ewy-koru", base: "EWYUSDT", leveraged: "KORUUSDT", factor: 3, mode: "returns" },
  "sndk-snxx": { id: "sndk-snxx", base: "SNDKUSDT", leveraged: "SNXXUSDT", factor: 2, mode: "returns" },
  "mrvl-mvll": { id: "mrvl-mvll", base: "MRVLUSDT", leveraged: "MVLLUSDT", factor: 2, mode: "returns" },
  "qqq-tqqq": { id: "qqq-tqqq", base: "QQQUSDT", leveraged: "TQQQUSDT", factor: 3, mode: "returns" },
  "tencent-hk0700": {
    id: "tencent-hk0700",
    base: "TENCENTUSDT",
    leveraged: "HK0700USDT",
    factor: 1,
    mode: "ratio",
    priceRatio: 7.84,
  },
  "hk1810-oracle": { id: "hk1810-oracle", base: "HK1810USDT", leveraged: "HK1810USDT", factor: 1, mode: "oracle", priceRatio: 1 },
  "hk0700-oracle": { id: "hk0700-oracle", base: "HK0700USDT", leveraged: "HK0700USDT", factor: 1, mode: "oracle", priceRatio: 1 },
  "tencent-oracle": { id: "tencent-oracle", base: "TENCENTUSDT", leveraged: "TENCENTUSDT", factor: 1, mode: "oracle", priceRatio: 1 },
};

const SYMBOL_PATTERN = /^[A-Z0-9]{3,24}$/;

const validNumber = (value: string | null, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

export function resolvePair(url: URL): ApiPair | null {
  const pairId = url.searchParams.get("pair") || "ewy-koru";
  const builtin = BUILTIN_PAIRS[pairId];
  if (builtin) return builtin;
  if (!pairId.startsWith("custom-")) return null;

  const mode = url.searchParams.get("mode") as PairMode | null;
  const base = (url.searchParams.get("base") || "").toUpperCase();
  const comparison = (url.searchParams.get("leveraged") || "").toUpperCase();
  if (!mode || !["returns", "ratio", "oracle"].includes(mode) || !SYMBOL_PATTERN.test(base)) return null;

  if (mode === "oracle") {
    return { id: pairId, base, leveraged: base, factor: 1, mode, priceRatio: 1 };
  }

  if (!SYMBOL_PATTERN.test(comparison)) return null;
  const factor = validNumber(url.searchParams.get("factor"), 0.01, 20);
  if (factor === null) return null;

  if (mode === "ratio") {
    const priceRatio = validNumber(url.searchParams.get("priceRatio"), 0.000001, 1_000_000);
    if (priceRatio === null) return null;
    return { id: pairId, base, leveraged: comparison, factor, mode, priceRatio };
  }

  return { id: pairId, base, leveraged: comparison, factor, mode };
}
