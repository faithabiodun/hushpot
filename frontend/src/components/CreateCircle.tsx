import { useState } from "react";
import { ethers } from "ethers";
import { parseToken } from "../lib/format";

export function CreateCircle({
  open,
  onClose,
  busy,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  busy: string | null;
  onCreate: (members: string[], contribution: bigint, collateral: bigint, feeBps: number) => Promise<void>;
}) {
  const [membersText, setMembersText] = useState("");
  const [contribution, setContribution] = useState("1");
  const [collateral, setCollateral] = useState("2");
  const [feeBps, setFeeBps] = useState("100");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    setError(null);
    const members = membersText
      .split(/[\s,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (members.length < 2) return setError("Need at least 2 members.");
    for (const m of members) if (!ethers.isAddress(m)) return setError(`Invalid address: ${m}`);
    const fee = Number(feeBps);
    if (Number.isNaN(fee) || fee < 0 || fee >= 10000) return setError("Fee must be 0–9999 bps.");
    await onCreate(members, parseToken(contribution), parseToken(collateral), fee);
    onClose();
  };

  return (
    <div className="palette__scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 92vw)" }}>
        <div className="panel__head">
          <span className="panel__title">New Circle</span>
        </div>
        <div className="deck">
          <label className="eyebrow">Members (addresses, comma or newline separated)</label>
          <textarea
            className="field"
            rows={4}
            value={membersText}
            placeholder="0xabc…&#10;0xdef…"
            onChange={(e) => setMembersText(e.target.value)}
          />
          <div className="row">
            <div className="grow">
              <label className="eyebrow">Contribution (cUSDT)</label>
              <input className="field" value={contribution} onChange={(e) => setContribution(e.target.value)} />
            </div>
            <div className="grow">
              <label className="eyebrow">Collateral (cUSDT)</label>
              <input className="field" value={collateral} onChange={(e) => setCollateral(e.target.value)} />
            </div>
            <div className="grow">
              <label className="eyebrow">Fee (bps)</label>
              <input className="field" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} />
            </div>
          </div>
          {error && <span className="deck__hint" style={{ color: "var(--led-default)" }}>{error}</span>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => void submit()}>
              {busy === "create" ? "Creating…" : "Create circle"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
