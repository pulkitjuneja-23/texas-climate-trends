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
    title: "Forecast for next month",
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
              icon. The art IS the summary — it should be readable before the
              headline is.
            */}
            <span className="pc-art" aria-hidden="true">
              {/*
                The three things this panel puts side by side: the accumulated
                curve, the water, and the crop it is grown for. The graph cell
                is drawn rather than photographed because it has to say
                specifically THIS chart — a band with one year traced through
                it — and no photograph can.
              */}
              {p.id === "season" && (
                <span className="art-trio">
                  <i className="art-graph">
                    <svg viewBox="0 0 60 92" preserveAspectRatio="none">
                      {/* The middle-half band, then this year running through
                          it — the season tracker in miniature. */}
                      <path
                        d="M0 66 C 12 58, 22 50, 32 41 S 50 25, 60 17 L60 33 C50 41, 42 51, 32 57 S12 72, 0 78 Z"
                        fill="var(--band-inner)"
                      />
                      <path
                        d="M0 72 C 12 64, 20 60, 28 50 S 44 39, 60 21"
                        fill="none"
                        stroke="var(--series-1)"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </i>
                  <i className="art-water" />
                  <i className="art-good" />
                </span>
              )}
              {/*
                Four seasons one field can have: too much water, sun, drought,
                and the harvest they all end in. The panel asks which past year
                this one resembles, and these are the answers it can give.
              */}
              {p.id === "analog" && (
                <span className="art-quad">
                  <i className="aq-rain" />
                  <i className="aq-sun" />
                  <i className="aq-dry" />
                  <i className="aq-harvest" />
                </span>
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

          </button>
        );
      })}
    </nav>
  );
}
