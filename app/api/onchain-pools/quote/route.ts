import { createPublicClient, defineChain, fallback, getAddress, http, isAddress, type Abi } from "viem";
import { findOnchainPool, ONCHAIN_POOLS, type OnchainPoolConfig } from "../../../lib/onchainPools";

export const dynamic = "force-dynamic";

const POOL_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const satisfies Abi;

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const chain = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"] } },
  blockExplorers: { default: { name: "OKX Explorer", url: "https://www.okx.com/web3/explorer/xlayer" } },
});
const client = createPublicClient({
  chain,
  transport: fallback([http("https://rpc.xlayer.tech", { timeout: 7_000 }), http("https://xlayerrpc.okx.com", { timeout: 7_000 })], { rank: false }),
  batch: { multicall: true },
});

const stableSymbol = (symbol: string) => /^(USDC(?:\.E)?|USDG|USDT0?|USD₮0)$/i.test(symbol);
const toUnits = (value: bigint, decimals: number) => Number(value) / 10 ** decimals;
const jsonNumber = (value: number) => Number.isFinite(value) ? value : null;

type PoolPayload = {
  id: string;
  label: string;
  name: string;
  displayBase: string;
  displayQuote: string;
  stockSymbol: string;
  chain: string;
  chainId: number;
  protocol: string;
  poolAddress: string;
  explorerUrl: string;
  fee: number;
  feePct: number;
  feeVerified: boolean;
  baseSymbol: string;
  quoteSymbol: string;
  baseAddress: string;
  quoteAddress: string;
  spotPrice: number | null;
  buyPriceBeforeSlippage: number | null;
  sellPriceBeforeSlippage: number | null;
  baseBalance: number | null;
  quoteBalance: number | null;
  tvlQuote: number | null;
  activeLiquidity: string;
  tick: number;
  unlocked: boolean;
  blockNumber: string;
  blockTimestamp: number;
  timestamp: number;
};

const quoteCache = new Map<string, { expiresAt: number; payload: PoolPayload }>();

const cleanLabel = (value: string | null, fallbackValue: string) => {
  const cleaned = (value ?? "").trim().replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 32);
  return cleaned || fallbackValue;
};

const customPoolFromUrl = (url: URL): OnchainPoolConfig | null => {
  const rawAddress = url.searchParams.get("address")?.trim() ?? "";
  if (!rawAddress) return null;
  if (!isAddress(rawAddress)) throw new Error("Invalid X Layer pool contract address.");
  const stockSymbol = (url.searchParams.get("stock") ?? "").trim().toUpperCase();
  if (!/^HK\.\d{5}$/.test(stockSymbol)) throw new Error("Stock symbol must use HK.00000 format.");
  const poolAddress = getAddress(rawAddress);
  const expectedFee = Number(url.searchParams.get("fee") ?? "500");
  if (!Number.isInteger(expectedFee) || expectedFee < 1 || expectedFee > 1_000_000) throw new Error("Invalid Uniswap V3 fee tier.");
  const displayBase = cleanLabel(url.searchParams.get("base"), "CUSTOM");
  const displayQuote = cleanLabel(url.searchParams.get("quote"), "USD");
  return {
    id: `custom-${poolAddress.toLowerCase()}`,
    label: `${displayBase}–${displayQuote}`,
    name: cleanLabel(url.searchParams.get("name"), displayBase),
    displayBase,
    displayQuote,
    stockSymbol,
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress,
    expectedFee,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: `https://www.okx.com/web3/explorer/xlayer/address/${poolAddress}`,
  };
};

async function readPool(pool: OnchainPoolConfig, blockNumber: bigint, blockTimestamp: number): Promise<PoolPayload> {
  const cached = quoteCache.get(pool.id);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const [token0, token1, fee, liquidity, slot0] = await Promise.all([
    client.readContract({ address: pool.poolAddress, abi: POOL_ABI, functionName: "token0" }),
    client.readContract({ address: pool.poolAddress, abi: POOL_ABI, functionName: "token1" }),
    client.readContract({ address: pool.poolAddress, abi: POOL_ABI, functionName: "fee" }),
    client.readContract({ address: pool.poolAddress, abi: POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address: pool.poolAddress, abi: POOL_ABI, functionName: "slot0" }),
  ]);
  const [symbol0, symbol1, decimals0, decimals1, balance0Raw, balance1Raw] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "balanceOf", args: [pool.poolAddress] }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "balanceOf", args: [pool.poolAddress] }),
  ]);

  const sqrtPriceX96 = slot0[0];
  const rawToken1PerToken0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const token1PerToken0 = rawToken1PerToken0 * 10 ** (Number(decimals0) - Number(decimals1));
  const token0IsQuote = stableSymbol(symbol0) && !stableSymbol(symbol1);
  const token1IsQuote = stableSymbol(symbol1) && !stableSymbol(symbol0);
  if (!token0IsQuote && !token1IsQuote) throw new Error(`${pool.label}: no recognized USD quote token.`);

  const spotPrice = token1IsQuote ? token1PerToken0 : 1 / token1PerToken0;
  const baseSymbol = token1IsQuote ? symbol0 : symbol1;
  const quoteSymbol = token1IsQuote ? symbol1 : symbol0;
  const baseAddress = token1IsQuote ? token0 : token1;
  const quoteAddress = token1IsQuote ? token1 : token0;
  const baseDecimals = Number(token1IsQuote ? decimals0 : decimals1);
  const quoteDecimals = Number(token1IsQuote ? decimals1 : decimals0);
  const baseBalance = toUnits(token1IsQuote ? balance0Raw : balance1Raw, baseDecimals);
  const quoteBalance = toUnits(token1IsQuote ? balance1Raw : balance0Raw, quoteDecimals);
  const feeFraction = Number(fee) / 1_000_000;
  const payload: PoolPayload = {
    id: pool.id,
    label: pool.label,
    name: pool.name,
    displayBase: pool.displayBase,
    displayQuote: pool.displayQuote,
    stockSymbol: pool.stockSymbol,
    chain: pool.chain,
    chainId: pool.chainId,
    protocol: pool.protocol,
    poolAddress: pool.poolAddress,
    explorerUrl: pool.explorerUrl,
    fee: Number(fee),
    feePct: Number(fee) / 10_000,
    feeVerified: Number(fee) === pool.expectedFee,
    baseSymbol,
    quoteSymbol,
    baseAddress,
    quoteAddress,
    spotPrice: jsonNumber(spotPrice),
    buyPriceBeforeSlippage: jsonNumber(spotPrice / (1 - feeFraction)),
    sellPriceBeforeSlippage: jsonNumber(spotPrice * (1 - feeFraction)),
    baseBalance: jsonNumber(baseBalance),
    quoteBalance: jsonNumber(quoteBalance),
    tvlQuote: jsonNumber(quoteBalance + baseBalance * spotPrice),
    activeLiquidity: liquidity.toString(),
    tick: slot0[1],
    unlocked: slot0[6],
    blockNumber: blockNumber.toString(),
    blockTimestamp,
    timestamp: Date.now(),
  };
  quoteCache.set(pool.id, { expiresAt: Date.now() + 2_000, payload });
  return payload;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  let customPool: OnchainPoolConfig | null = null;
  try {
    customPool = customPoolFromUrl(url);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid custom pool." }, { status: 400 });
  }
  const pools = group === "hk"
    ? [...ONCHAIN_POOLS]
    : customPool ? [customPool] : [findOnchainPool(url.searchParams.get("id"))].flatMap((pool) => pool ? [pool] : []);
  if (!pools.length) return Response.json({ error: "Unknown or unverified pool." }, { status: 404 });

  try {
    const blockNumber = await client.getBlockNumber();
    const block = await client.getBlock({ blockNumber });
    const blockTimestamp = Number(block.timestamp) * 1_000;
    const results = await Promise.allSettled(pools.map((pool) => readPool(pool, blockNumber, blockTimestamp)));
    const quotes = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "Pool state unavailable."]
      : []);
    if (!quotes.length) throw new Error(errors[0] || "X Layer RPC unavailable.");
    const body = group === "hk" ? { quotes, errors, timestamp: Date.now() } : quotes[0];
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "X Layer RPC unavailable." }, { status: 502 });
  }
}
