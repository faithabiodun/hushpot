// Network + contract configuration. Addresses are injected at build time via Vite env vars
// (VITE_HUSHPOT_ADDRESS, VITE_CUSDT_ADDRESS) and recorded in the README after deployment.

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_HEX = "0xaa36a7";

// Official Zama Sepolia cUSDT wrapper (ERC-7984). Overridable via env for safety if Zama rotates it.
export const DEFAULT_CUSDT = "0x4E7B06D78965594eB5EF5414c357ca21E1554491";

export const HUSHPOT_ADDRESS = (import.meta.env.VITE_HUSHPOT_ADDRESS ?? "").trim();
export const CUSDT_ADDRESS = (import.meta.env.VITE_CUSDT_ADDRESS ?? DEFAULT_CUSDT).trim();

// cUSDT is 6 decimals.
export const TOKEN_DECIMALS = 6;

export const SEPOLIA_PARAMS = {
  chainId: SEPOLIA_CHAIN_HEX,
  chainName: "Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.sepolia.org"],
  blockExplorerUrls: ["https://sepolia.etherscan.io"],
};

export const RoundState = {
  OPEN: 0,
  BIDDING: 1,
  RESOLVING: 2,
  SETTLED: 3,
} as const;

export const ROUND_STATE_LABEL = ["OPEN", "BIDDING", "RESOLVING", "SETTLED"] as const;
