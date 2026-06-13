import type { CircleView, Seat } from "../lib/types";
import { shortAddr } from "../lib/format";

function ledClass(s: Seat): string {
  if (s.isRoundWinner) return "var(--zama-yellow)";
  if (s.defaulted) return "var(--led-default)";
  if (s.bid) return "var(--led-bidding)";
  if (s.paid) return "var(--led-open)";
  if (s.joined) return "var(--led-idle)";
  return "var(--led-idle)";
}

export function SeatsPanel({
  circle,
  seats,
  canSlash,
  onSlash,
}: {
  circle: CircleView | null;
  seats: Seat[];
  canSlash: boolean;
  onSlash: (addr: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Seats</span>
        <span className="eyebrow">{circle ? `${seats.length} members` : ""}</span>
      </div>
      <div className="seats">
        {seats.length === 0 && <div className="log__empty">No circle loaded.</div>}
        {seats.map((s) => (
          <div className={`seat ${s.isYou ? "seat--you" : ""}`} key={s.address}>
            <span className="seat__idx">
              <span className="led" style={{ color: ledClass(s), background: ledClass(s) }} /> {s.index}
            </span>
            <span className="seat__addr">
              {shortAddr(s.address)} {s.isYou && <span className="seat__you">· YOU</span>}
            </span>
            <span className="seat__chips">
              {s.hasWon && <span className="chip chip--won">won</span>}
              {s.defaulted && <span className="chip chip--default">default</span>}
              {s.bid && !s.defaulted && <span className="chip chip--bid">bid</span>}
              {s.paid && !s.defaulted && <span className="chip chip--paid">paid</span>}
              {s.isRoundWinner && <span className="chip chip--winner">winner</span>}
            </span>
            <span>
              {canSlash && s.joined && !s.paid && !s.defaulted && (
                <button className="btn btn--danger" style={{ padding: "4px 8px" }} onClick={() => onSlash(s.address)}>
                  slash
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
