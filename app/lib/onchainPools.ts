export type OnchainPoolConfig = {
  id: string;
  label: string;
  name: string;
  displayBase: string;
  displayQuote: string;
  stockSymbol: string;
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
    name: "Xiaomi",
    displayBase: "XIAOx",
    displayQuote: "USDC",
    stockSymbol: "HK.01810",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0xdc7f2f41b48cd4f482d8c900ac2fa1b5ad058417",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0xdc7f2f41b48cd4f482d8c900ac2fa1b5ad058417",
  },
  {
    id: "mixux-usdg-005-xlayer",
    label: "MIXUx–USDG",
    name: "Mixue Group",
    displayBase: "MIXUx",
    displayQuote: "USDG",
    stockSymbol: "HK.02097",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0x94d64ac04ac580a72fd481bcd1ca7d83bd4ac3b8",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0x94d64ac04ac580a72fd481bcd1ca7d83bd4ac3b8",
  },
  {
    id: "kuaix-usdg-005-xlayer",
    label: "KUAIx–USDG",
    name: "Kuaishou",
    displayBase: "KUAIx",
    displayQuote: "USDG",
    stockSymbol: "HK.01024",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0x9d5d95416412643004af849e012c894d4689a0f2",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0x9d5d95416412643004af849e012c894d4689a0f2",
  },
  {
    id: "hkexcx-usdg-005-xlayer",
    label: "HKEXCx–USDG",
    name: "HKEX",
    displayBase: "HKEXCx",
    displayQuote: "USDG",
    stockSymbol: "HK.00388",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0x293a6167bed3a474b99f450de817bc4474087ed4",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0x293a6167bed3a474b99f450de817bc4474087ed4",
  },
  {
    id: "tcentx-usdg-005-xlayer",
    label: "TCENTx–USDG",
    name: "Tencent",
    displayBase: "TCENTx",
    displayQuote: "USDG",
    stockSymbol: "HK.00700",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0xc89d8b547cea7cdeaa7474e7a90b6bad01fe992f",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0xc89d8b547cea7cdeaa7474e7a90b6bad01fe992f",
  },
  {
    id: "meitx-usdg-005-xlayer",
    label: "MEITx–USDG",
    name: "Meituan",
    displayBase: "MEITx",
    displayQuote: "USDG",
    stockSymbol: "HK.03690",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0x54e89e9acafb073e7fd8471312e753a661b470c7",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0x54e89e9acafb073e7fd8471312e753a661b470c7",
  },
  {
    id: "popmtx-usdc-005-xlayer",
    label: "POPMTx–USDC",
    name: "Pop Mart",
    displayBase: "POPMTx",
    displayQuote: "USDC",
    stockSymbol: "HK.09992",
    chain: "X Layer",
    chainId: 196,
    protocol: "Uniswap V3",
    poolAddress: "0x4cd5c98fed5cc94876078cfb914f71b33a83152d",
    expectedFee: 500,
    rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    explorerUrl: "https://www.okx.com/web3/explorer/xlayer/address/0x4cd5c98fed5cc94876078cfb914f71b33a83152d",
  },
] as const;

export const findOnchainPool = (id: string | null) => ONCHAIN_POOLS.find((pool) => pool.id === id) ?? null;
