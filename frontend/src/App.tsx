import { useEffect, useMemo, useState } from "react";
import { useWallet } from "./lib/useWallet";
import { useHushpot } from "./lib/useHushpot";
import { HUSHPOT_ADDRESS, CUSDT_ADDRESS, RoundState } from "./lib/config";
import { shortAddr } from "./lib/format";
import { TopBar } from "./components/TopBar";
import { KpiTicker } from "./components/KpiTicker";
import { SeatsPanel } from "./components/SeatsPanel";
import { CircleRing } from "./components/CircleRing";
import { ActionDeck } from "./components/ActionDeck";
import { EventLog } from "./components/EventLog";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { CreateCircle } from "./components/CreateCircle";
import { ResolveSequence } from "./components/ResolveSequence";

export function App() {
  const wallet = useWallet();
  const hp = useHushpot(wallet);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [resolveStage, setResolveStage] = useState(0);

  const mySeat = useMemo(
    () => hp.seats.find((s) => s.isYou) ?? null,
    [hp.seats],
  );

  // ⌘K / Ctrl-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drive the resolve-sequence overlay stages off the live event log while resolving.
  useEffect(() => {
    if (hp.busy !== "resolve") {
      setResolveStage(0);
      return;
    }
    const last = hp.events[0]?.text ?? "";
    if (last.includes("Finalizing")) setResolveStage(2);
    else if (last.includes("Decrypting")) setResolveStage(1);
    else setResolveStage(0);
  }, [hp.busy, hp.events]);

  const deadlinePassed =
    !!hp.circle && hp.circle.roundDeadline > 0 && Date.now() / 1000 >= hp.circle.roundDeadline;

  const commands: Command[] = [
    { id: "create", label: "Create new circle", run: () => setCreateOpen(true), enabled: wallet.onSepolia },
    {
      id: "join",
      label: "Join circle (lock collateral)",
      run: () => hp.circle && void hp.joinCircle(hp.circle.collateral),
      enabled: !!hp.circle && !hp.circle.active && !(mySeat?.joined ?? false),
    },
    {
      id: "contribute",
      label: "Contribute to current round",
      run: () => hp.circle && void hp.contribute(hp.circle.contribution),
      enabled: !!hp.circle?.active && hp.circle.state === RoundState.OPEN && !(mySeat?.paid ?? false),
    },
    {
      id: "resolve",
      label: "Resolve round (blind auction)",
      hint: "argmax",
      run: () => void hp.resolveAndFinalize(),
      enabled: !!hp.circle?.active && hp.circle.state === RoundState.OPEN && deadlinePassed,
    },
    {
      id: "claim",
      label: "Claim pot",
      run: () => void hp.claimPot(),
      enabled: hp.circle?.state === RoundState.SETTLED && (mySeat?.isRoundWinner ?? false),
    },
    {
      id: "reveal",
      label: "Reveal pot (decrypt for you)",
      run: () => void hp.revealPot(),
      enabled: mySeat?.isRoundWinner ?? false,
    },
    {
      id: "withdraw",
      label: "Withdraw collateral",
      run: () => void hp.withdrawCollateral(),
      enabled: hp.circle?.completed ?? false,
    },
    { id: "refresh", label: "Refresh desk", hint: "↻", run: () => void hp.refresh() },
  ];

  // Gate: configuration missing.
  if (!HUSHPOT_ADDRESS) {
    return (
      <div className="desk">
        <TopBar wallet={wallet} onPalette={() => setPaletteOpen(true)} />
        <div className="gate">
          <div className="gate__card">
            <h2>Desk not configured</h2>
            <p className="deck__hint">
              Set <span className="mono">VITE_HUSHPOT_ADDRESS</span> (and optionally{" "}
              <span className="mono">VITE_CUSDT_ADDRESS</span>) and rebuild. The contract address is
              recorded in the project README after deployment to Sepolia.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="desk">
      <TopBar wallet={wallet} onPalette={() => setPaletteOpen(true)} />

      <KpiTicker circle={hp.circle} seats={hp.seats} potClear={hp.potClear} />

      <div className="main">
        <div className="col">
          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">Circle</span>
              <div className="row" style={{ alignItems: "center" }}>
                <span className="eyebrow">id</span>
                <input
                  className="field mono"
                  style={{ width: 70, padding: "4px 8px" }}
                  value={hp.circleId}
                  inputMode="numeric"
                  onChange={(e) => hp.setCircleId(Number(e.target.value) || 0)}
                />
                <button className="btn btn--ghost" onClick={() => setCreateOpen(true)} disabled={!wallet.onSepolia}>
                  + New
                </button>
              </div>
            </div>
            <div className="deck">
              {hp.circle ? (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="deck__hint">
                    {hp.circle.totalRounds} seats ·
                    <span className="mono"> {hp.circle.feeBps / 100}%</span> insurance fee
                  </span>
                  <span className="tag">{hp.circle.completed ? "COMPLETED" : hp.circle.active ? "ACTIVE" : "FORMING"}</span>
                </div>
              ) : (
                <span className="deck__hint">No circle at id {hp.circleId}. Create one or pick another id.</span>
              )}
            </div>
          </section>

          <SeatsPanel
            circle={hp.circle}
            seats={hp.seats}
            canSlash={!!hp.circle?.active && hp.circle.state === RoundState.OPEN && deadlinePassed}
            onSlash={(addr) => void hp.slashDefaulter(addr)}
          />

          <ActionDeck
            circle={hp.circle}
            mySeat={mySeat}
            busy={hp.busy}
            actions={{
              joinCircle: hp.joinCircle,
              contribute: hp.contribute,
              submitBid: hp.submitBid,
              resolveAndFinalize: hp.resolveAndFinalize,
              claimPot: hp.claimPot,
              withdrawCollateral: hp.withdrawCollateral,
              revealPot: hp.revealPot,
            }}
          />
        </div>

        <div className="col">
          <CircleRing circle={hp.circle} seats={hp.seats} potClear={hp.potClear} />
          <EventLog events={hp.events} />
        </div>
      </div>

      <footer className="foot">
        <span>
          Hushpot · {shortAddr(HUSHPOT_ADDRESS)} · cUSDT {shortAddr(CUSDT_ADDRESS)}
        </span>
        <span>Sealed bids · only the winner index is ever revealed · ⌘K for commands</span>
      </footer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <CreateCircle
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        busy={hp.busy}
        onCreate={hp.createCircle}
      />
      <ResolveSequence active={hp.busy === "resolve"} stage={resolveStage} />
    </div>
  );
}
