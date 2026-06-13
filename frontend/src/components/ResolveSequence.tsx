// The §8.4 signature moment: a focused overlay narrating the blind-auction resolution as it runs.
// Driven by the `busy === "resolve"` flag and the event-log lines the hook emits.

const STEPS = [
  { key: "argmax", label: "Compute argmax over sealed bids (encrypted)" },
  { key: "decrypt", label: "Public-decrypt the winning index only" },
  { key: "finalize", label: "Verify KMS proof & seal the winner on-chain" },
];

export function ResolveSequence({ active, stage }: { active: boolean; stage: number }) {
  if (!active) return null;
  return (
    <div className="resolve-seq" role="dialog" aria-label="resolving round">
      <div className="resolve-card">
        <div className="resolve-card__title">◢ Blind-auction resolution</div>
        <div className="resolve-steps">
          {STEPS.map((s, i) => {
            const cls = i < stage ? "resolve-step--done" : i === stage ? "resolve-step--active" : "";
            return (
              <div className={`resolve-step ${cls}`} key={s.key}>
                <span className="resolve-step__mark">
                  {i < stage ? "✓" : i === stage ? <span className="spinner" /> : i + 1}
                </span>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
