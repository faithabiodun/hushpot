import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { SEPOLIA_CHAIN_ID, SEPOLIA_CHAIN_HEX, SEPOLIA_PARAMS } from "./config";

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...a: unknown[]) => void) => void;
};

function getEthereum(): Eip1193 | undefined {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum;
}

export type WalletState = {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  provider: ethers.BrowserProvider | null;
  signer: ethers.JsonRpcSigner | null;
  onSepolia: boolean;
  hasWallet: boolean;
  connect: () => Promise<void>;
  switchToSepolia: () => Promise<void>;
};

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);

  const refresh = useCallback(async () => {
    const eth = getEthereum();
    if (!eth) return;
    const bp = new ethers.BrowserProvider(eth);
    const net = await bp.getNetwork();
    setChainId(Number(net.chainId));
    const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
    if (accounts.length > 0) {
      const s = await bp.getSigner();
      setProvider(bp);
      setSigner(s);
      setAddress(await s.getAddress());
    } else {
      setProvider(bp);
      setSigner(null);
      setAddress(null);
    }
  }, []);

  const connect = useCallback(async () => {
    const eth = getEthereum();
    if (!eth) return;
    setConnecting(true);
    try {
      await eth.request({ method: "eth_requestAccounts" });
      await refresh();
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  const switchToSepolia = useCallback(async () => {
    const eth = getEthereum();
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_HEX }] });
    } catch (err: unknown) {
      // 4902 = chain not added.
      if ((err as { code?: number }).code === 4902) {
        await eth.request({ method: "wallet_addEthereumChain", params: [SEPOLIA_PARAMS] });
      }
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const eth = getEthereum();
    if (!eth?.on) return;
    void refresh();
    const onAccounts = () => void refresh();
    const onChain = () => window.location.reload();
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [refresh]);

  return {
    address,
    chainId,
    connecting,
    provider,
    signer,
    onSepolia: chainId === SEPOLIA_CHAIN_ID,
    hasWallet: !!getEthereum(),
    connect,
    switchToSepolia,
  };
}
