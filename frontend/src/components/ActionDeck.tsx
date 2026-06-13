import { useState } from "react";
import type { CircleView, Seat } from "../lib/types";
import { RoundState, ROUND_STATE_LABEL } from "../lib/config";
import { fmtToken, parseToken } from "../lib/format";

type Actions = {
  joinCircle: (collateral: bigint) => Promise<void>;
  contribute: (amount: bigint) => Promise<void>;
  submitBid: (amount: bigint) => Promise<void>;
  resolveAndFinalize: () => Promise<void>;
  claimPot: () => Promise<void>;
  withdrawCollateral: () => Promise<void>;
  revealPot: () => Promise<void>;
};

export function ActionDeck({
  circle,
  mySeat,
  busy,
  actions,
}: {
  circle: CircleView | null;
  mySeat: Seat | null;
  busy: string | null;
  actions: Actions;
}) {
  const [bid, setBid] = useState("");
  const isBusy = busy !== null;

  if (!circle) {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Action Deck</span>
        </div>
        <div className="deck">
          <p className="deck__hint">Load or create a circle to begin.</p>
        </div>
      </section>
    );
  }

  const stateLabel = ROUND_STATE_LABEL[circle.state];
  const deadlinePassed = circle.roundDeadline > 0 && Date.now() / 1000 >= circle.roundDeadline;

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Action Deck</span>
        <span className={`badge badge--${stateLabel}`}>
          <span className="led" /> {stateLabel}
        </span>
      </div>
      <div className="deck">
        {/* Join (pre-activation) */}
        {!circle.active && (
          <div className="deck__row">
            <span className="deck__hint">
              Lock collateral ({fmtToken(circle.collateral)} cUSDT) to take your seat.
            </span>
            <button className="btn" disabled={isBusy || (mySeat?.joined ?? false)} onClick={() => void actions.joinCircle(circle.collateral)}>
              {mySeat?.joined ? "Joined" : busy === "join" ? "Joining…" : "Join"}
            </button>
          </div>
        )}

        {/* Contribute */}
        {circle.active && !circle.completed && circle.state === RoundState.OPEN && (
          <div className="deck__row">
            <span className="deck__hint">
              Contribute {fmtToken(circle.contribution)} cUSDT to this round's pot.
            </span>
            <button
              className="btn"
              disabled={isBusy || (mySeat?.paid ?? false) || !mySeat?.joined}
              onClick={() => void actions.contribute(circle.contribution)}
            >
              {mySeat?.paid ? "Paid" : busy === "contribute" ? "Sealing…" : "Contribute"}
            </button>
          </div>
        )}

        {/* Sealed bid */}
        {circle.active && !circle.completed && circle.state === RoundState.OPEN && !mySeat?.hasWon && (
          <div className="deck__row">
            <input
              className="field"
              placeholder="Sealed bid (cUSDT)"
              value={bid}
              inputMode="decimal"
              onChange={(e) => setBid(e.target.value)}
              disabled={isBusy || (mySeat?.bid ?? false)}
            />
            <button
              className="btn"
              disabled={isBusy || !bid || (mySeat?.bid ?? false) || !mySeat?.joined}
              onClick={() => void actions.submitBid(parseToken(bid)).then(() => setBid(""))}
            >
              {mySeat?.bid ? "Bid in" : busy === "bid" ? "Sealing…" : "Seal bid"}
            </button>
          </div>
        )}

        {/* Resolve (deadline reached, OPEN) */}
        {circle.active && !circle.completed && circle.state === RoundState.OPEN && deadlinePassed && (
          <div className="deck__row">
            <span className="deck__hint">Deadline passed — run the blind-auction resolution.</span>
            <button className="btn" disabled={isBusy} onClick={() => void actions.resolveAndFinalize()}>
              {busy === "resolve" ? "Resolving…" : "Resolve round"}
            </button>
          </div>
        )}

        {/* Finalized but not yet on-chain settled handled inside resolveAndFinalize */}

        {/* Claim (settled, you won) */}
        {circle.state === RoundState.SETTLED && mySeat?.isRoundWinner && (
          <div className="deck__row">
            <span className="deck__hint">You won this round. Claim the pot.</span>
            <button className="btn" disabled={isBusy} onClick={() => void actions.claimPot()}>
              {busy === "claim" ? "Claiming…" : "Claim pot"}
            </button>
          </div>
        )}

        {/* Reveal pot (winner) */}
        {mySeat?.isRoundWinner && (
          <div className="deck__row">
            <span className="deck__hint">Decrypt the pot amount (only you can).</span>
            <button className="btn btn--ghost" disabled={isBusy} onClick={() => void actions.revealPot()}>
              Reveal pot
            </button>
          </div>
        )}

        {/* Withdraw collateral (completed) */}
        {circle.completed && (
          <div className="deck__row">
            <span className="deck__hint">Circle complete. Reclaim your collateral (non-defaulters).</span>
            <button
              className="btn"
              disabled={isBusy || (mySeat?.defaulted ?? false)}
              onClick={() => void actions.withdrawCollateral()}
            >
              {busy === "withdraw" ? "Withdrawing…" : "Withdraw collateral"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
