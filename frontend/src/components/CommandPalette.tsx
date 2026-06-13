import { useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  enabled?: boolean;
};

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const list = commands.filter((c) => c.enabled !== false);
    if (!q.trim()) return list;
    const needle = q.toLowerCase();
    return list.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        cmd.run();
        onClose();
      }
    }
  };

  return (
    <div className="palette__scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__item">No commands</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette__item ${i === active ? "palette__item--active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                c.run();
                onClose();
              }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="palette__kbd">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
