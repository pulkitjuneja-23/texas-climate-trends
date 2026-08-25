"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceMeta } from "@/lib/types";

/**
 * Source picker, living in the sticky topbar so it can be changed from
 * anywhere on the page without scrolling back up.
 *
 * The dataset's own details (resolution, record start, currency) moved INTO the
 * menu rather than occupying a card of their own — they matter at the moment
 * you are choosing, not permanently. Unavailable sources stay listed with the
 * reason: the whole premise is that the grower can see what the choice is,
 * instead of being handed a hidden default.
 */

interface Props {
  sources: SourceMeta[];
  activeId: string;
  onChange: (id: string) => void;
  loading?: boolean;
  /** Station supplying the most recent days, shown in the menu footer. */
  station?: { id: string; name: string; distanceKm: number } | null;
}

function resolutionLabel(s: SourceMeta): string {
  return s.resolutionKm === 0 ? "Station" : `${s.resolutionKm} km`;
}

function lagLabel(s: SourceMeta): string {
  if (s.latencyDays === 0) return "up to date";
  if (s.latencyDays >= 60) return `${Math.round(s.latencyDays / 30)} months behind`;
  return `${s.latencyDays} days behind`;
}

export default function SourceSelect({
  sources,
  activeId,
  onChange,
  loading = false,
  station,
}: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const active = sources.find((s) => s.id === activeId);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="dropdown topbar-source" ref={boxRef}>
      <button
        className="dropdown-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which weather dataset the whole page is reading"
      >
        <span className="src-label">Source</span>
        <span>{active?.name ?? "Choose"}</span>
        {loading ? <span className="mini-spinner" aria-label="Loading" /> : <span className="caret">▼</span>}
      </button>

      {open && (
        <div className="dropdown-menu" role="listbox">
          {sources.map((s) => (
            <button
              key={s.id}
              className="dropdown-item"
              role="option"
              aria-selected={s.id === activeId}
              disabled={!s.available}
              onClick={() => {
                if (!s.available) return;
                onChange(s.id);
                setOpen(false);
              }}
            >
              <span className="di-name">
                {s.name}
                {!s.available && <span className="muted small">· not available</span>}
                {s.id === activeId && <span className="di-check">✓</span>}
              </span>
              <span className="di-meta">
                {resolutionLabel(s)} · from {s.startYear} · {lagLabel(s)}
                <br />
                {s.available ? s.blurb : s.note}
              </span>
            </button>
          ))}
          {station && (
            <div className="dropdown-foot">
              Most recent days come from <strong>{station.id}</strong> ({station.name}),{" "}
              {station.distanceKm} km away — a real gauge, not a model.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
