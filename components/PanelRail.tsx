"use client";

/**
 * The four deep views, as a row of covers you open one at a time.
 *
 * WHY NOT JUST STACK THEM. Four full analyses down one page is a wall — a
 * grower scrolling for the one thing they came for has to pass three they
 * didn't. And rendered as four identical white cards, nothing signals that they
 * answer completely different questions.
 *
 * So each cover states its question as a headline, carries its own image, and
 * opens in place. Only the open one is mounted, which also means three charts
 * are not being computed for a reader looking at the fourth.
 *
 * NOT TABS. Tabs imply peers in a set; these are chapters of one argument about
 * a field, and the open one expands below the row rather than replacing it, so
 * the others stay visible as the rest of the story.
 */

export type PanelId = "season" | "analog" | "forecast" | "trend";

export interface PanelDef {
  id: PanelId;
  /** The question this view answers, in the grower's words. */
  title: string;
  /** One line of what they will actually see. */
  blurb: string;
  /** Short label for the open state. */
  short: string;
}

export const PANELS: PanelDef[] = [
  {
    id: "season",
    title: "Texas is getting warmer. What does that mean for your field?",
    blurb: "This season traced against thirty years, day by day.",
    short: "Season tracker",
  },
  {
    id: "analog",
    title: "Have we seen a season like this before?",
    blurb: "The years that started like this one — and what came next.",
    short: "Similar years",
  },
  {
    id: "forecast",
    title: "Three forecasts. Three levels of trust.",
    blurb: "Days 1–7, days 8–16, and weeks 2–4, kept deliberately apart.",
    short: "Next month",
  },
  {
    id: "trend",
    title: "Is it changing here — or is that just noise?",
    blurb: "One bar a year, with the trend and an honest word about it.",
    short: "Year by year",
  },
];

interface Props {
  active: PanelId;
  onChange: (id: PanelId) => void;
}

export default function PanelRail({ active, onChange }: Props) {
  return (
    <nav className="panel-rail" aria-label="Choose a view">
      {PANELS.map((p) => {
        const open = p.id === active;
        return (
          <button
            key={p.id}
            type="button"
            className={`panel-cover pc-${p.id}`}
            aria-expanded={open}
            aria-controls="panel-stage"
            onClick={() => onChange(p.id)}
          >
            {/*
              Each cover's art is specific to its question rather than a stock
              icon: a real lush/burnt pair, two seasons traced over each other,
              the three confidence bars, a run of yearly bars. The art IS the
              summary.
            */}
            <span className="pc-art" aria-hidden="true">
              {p.id === "season" && (
                <span className="art-split">
                  <i className="art-good" />
                  <i className="art-dry" />
                </span>
              )}
              {p.id === "analog" && (
                <svg viewBox="0 0 120 54" preserveAspectRatio="none">
                  <path className="a-ghost" d="M4 48 L26 42 L48 33 L70 26 L92 20 L116 15" />
                  <path className="a-ghost" d="M4 50 L26 47 L48 40 L70 28 L92 17 L116 9" />
                  <path className="a-dry" d="M4 49 L26 45 L48 39 L70 35 L92 33 L116 32" />
                  <path className="a-now" d="M4 48 L26 43 L48 34 L64 28" />
                  <circle className="a-dot" cx="64" cy="28" r="3.4" />
                </svg>
              )}
              {p.id === "forecast" && (
                <span className="art-conf">
                  <i style={{ width: "88%", background: "var(--good)" }} />
                  <i style={{ width: "52%", background: "var(--warning)" }} />
                  <i style={{ width: "26%", background: "var(--text-muted)" }} />
                </span>
              )}
              {p.id === "trend" && (
                <span className="art-bars">
                  {[54, 38, 74, 66, 41, 88, 59, 34, 71, 96, 29, 63, 80, 44, 69].map((h, i) => (
                    <i key={i} className={h < 45 ? "dry" : ""} style={{ height: `${h}%` }} />
                  ))}
                </span>
              )}
            </span>

            <span className="pc-text">
              <span className="pc-eyebrow">{p.short}</span>
              <span className="pc-title">{p.title}</span>
              <span className="pc-blurb">{p.blurb}</span>
            </span>

            <span className="pc-state" aria-hidden="true">
              {open ? "Showing" : "Open"}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
