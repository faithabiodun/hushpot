import type { CircleView, Seat } from "../lib/types";
import { fmtToken } from "../lib/format";

function nodeClass(s: Seat): string {
  if (s.isRoundWinner) return "ring__node--winner";
  if (s.defaulted) return "ring__node--default";
  if (s.bid) return "ring__node--bid";
  if (s.paid) return "ring__node--paid";
  return "";
}

export function CircleRing({
  circle,
  seats,
  potClear,
}: {
  circle: CircleView | null;
  seats: Seat[];
  potClear: bigint | null;
}) {
  const n = seats.length || 1;
  const R = 100; // radius in px
  const cx = 120;
  const cy = 120;

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Circle Ring</span>
        <span className="eyebrow">round {circle ? circle.currentRound + 1 : "—"}</span>
      </div>
      <div className="ring-wrap">
        <div className="ring" role="img" aria-label="circle of members around the pot">
          {seats.map((s, i) => {
            const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
            const x = cx + R * Math.cos(angle);
            const y = cy + R * Math.sin(angle);
            return (
              <div
                key={s.address}
                className={`ring__node ${nodeClass(s)}`}
                style={{ left: x, top: y }}
                title={s.address}
              >
                {s.index}
              </div>
            );
          })}
          <div className="ring__core">
            <span className="eyebrow">pot</span>
            <span className="ring__pot">{potClear === null ? "🔒" : fmtToken(potClear)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
