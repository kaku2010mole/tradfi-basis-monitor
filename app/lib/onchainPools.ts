export type OnchainPoolConfig = {
  id: string;
  label: string;
  displayBase: string;
  displayQuote: string;
  chain: string;
  chainId: number;
  protocol: string;
  poolAddress: `0x${string}`;
  expectedFee: number;
  rpcUrls: readonly string[];
  explorerUrl: string;
};

export const ONCHAIN_POOLS: readonly OnchainPoolConfig[] = [
  {
    id: "xiaox-usdc-005-xlayer",
    label: "XIAOx–USDC",
    displayBase: "XIAOx",
    displayQuote: "USDC",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0xdc7f2f41b48cd4f482d8c900ac2fa1b5ad058417",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0xdc7f2f41b48cd4f482d8c900ac2fa1b5ad058417",
  },
] as const;

export const findOnchainPool = (id: string | null) => ONCHAIN_POOLS.find((pool) => pool.id === id) ?? null;
