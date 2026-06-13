import type { WalletState } from "../lib/useWallet";
import { shortAddr } from "../lib/format";

export function TopBar({ wallet, onPalette }: { wallet: WalletState; onPalette: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand__mark" src="/lock.svg" alt="" />
        <div>
          <div className="brand__name">
            HUSH<b>POT</b>
          </div>
          <div className="brand__tag">Confidential savings desk · Zama Protocol</div>
        </div>
      </div>
      <div className="topbar__right">
        <button className="btn btn--ghost" onClick={onPalette} title="Command palette (⌘K)">
          ⌘K
        </button>
        {!wallet.hasWallet ? (
          <span className="wallet-chip wallet-chip--bad">
            <span className="led" /> No wallet
          </span>
        ) : !wallet.address ? (
          <button className="btn" disabled={wallet.connecting} onClick={() => void wallet.connect()}>
            {wallet.connecting ? "Connecting…" : "Connect"}
          </button>
        ) : !wallet.onSepolia ? (
          <button className="btn btn--danger" onClick={() => void wallet.switchToSepolia()}>
            Switch to Sepolia
          </button>
        ) : (
          <span className="wallet-chip">
            <span className="led" /> {shortAddr(wallet.address)}
          </span>
        )}
      </div>
    </header>
  );
}
