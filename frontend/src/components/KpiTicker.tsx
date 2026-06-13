import type { CircleView, Seat } from "../lib/types";
import { ROUND_STATE_LABEL } from "../lib/config";
import { fmtToken, fmtDeadline } from "../lib/format";

export function KpiTicker({
  circle,
  seats,
  potClear,
}: {
  circle: CircleView | null;
  seats: Seat[];
  potClear: bigint | null;
}) {
  const paid = seats.filter((s) => s.paid).length;
  const bids = seats.filter((s) => s.bid).length;
  return (
    <section className="ticker" aria-label="circle metrics">
      <div className="kpi">
        <span className="kpi__label">Round</span>
        <span className="kpi__value">
          {circle ? `${circle.currentRound + 1}/${circle.totalRounds}` : "—"}
        </span>
      </div>
      <div className="kpi">
        <span className="kpi__label">State</span>
        <span className="kpi__value">{circle ? ROUND_STATE_LABEL[circle.state] : "—"}</span>
      </div>
      <div className="kpi">
        <span className="kpi__label">Pot</span>
        <span className="kpi__value kpi__value--lock">{potClear === null ? "🔒 sealed" : fmtToken(potClear)}</span>
      </div>
      <div className="kpi">
        <span className="kpi__label">Paid · Bids</span>
        <span className="kpi__value">
          {paid} · {bids}
        </span>
      </div>
      <div className="kpi">
        <span className="kpi__label">Deadline</span>
        <span className="kpi__value">{circle ? fmtDeadline(circle.roundDeadline) : "—"}</span>
      </div>
    </section>
  );
}
