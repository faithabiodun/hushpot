import type { DeskEvent } from "../lib/types";
import { fmtTime } from "../lib/format";

export function EventLog({ events }: { events: DeskEvent[] }) {
  return (
    <section className="panel log">
      <div className="panel__head">
        <span className="panel__title">Event Log</span>
        <span className="eyebrow">live · on-chain</span>
      </div>
      <div className="log__body">
        {events.length === 0 && <div className="log__empty">Awaiting desk activity…</div>}
        {events.map((e) => (
          <div className="log__line" key={e.id}>
            <span className="log__time">{fmtTime(e.ts)}</span>
            <span className={`log__dot log__dot--${e.kind}`}>▍</span>
            <span className="log__text">
              {e.text}
              {e.txHash && (
                <>
                  {" "}
                  <a
                    href={`https://sepolia.etherscan.io/tx/${e.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx↗
                  </a>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
