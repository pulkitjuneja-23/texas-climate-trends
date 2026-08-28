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

/**
 * Six past seasons on the "similar years" cover, one of them picked out.
 *
 * Each array is one card's rainfall shape, 0 at the bottom of the card and 1 at
 * the top. They are hand-set rather than random so the picture is identical on
 * the server and the client — `Math.random()` in a render is a hydration
 * mismatch, and this is decoration, not data.
 */
const YEAR_CURVES = [
  [0.5, 0.34, 0.6, 0.4, 0.7],
  [0.3, 0.55, 0.44, 0.7, 0.5],
  [0.68, 0.5, 0.34, 0.56, 0.3],
  [0.44, 0.3, 0.56, 0.36, 0.66],
  [0.4, 0.64, 0.3, 0.6, 0.46],
  [0.6, 0.4, 0.5, 0.3, 0.55],
];

/** Which card is the match. Third of six — found among them, not at an end. */
const MATCHED_CARD = 3;

/** Card geometry, in the 300x92 viewBox. Shared by the rects and the curves. */
const CARD_W = 42;
const CARD_PITCH = 48;
const CARD_X0 = 10;
const HEADER_H = 9;

/** A card's little season curve, as a polyline path. */
function curvePath(curve: number[], x: number, top: number, height: number): string {
  const left = x + 6;
  const step = (CARD_W - 12) / (curve.length - 1);
  const bottom = top + height - 8;
  const span = height - HEADER_H - 17;
  return curve
    .map((v, i) => `${i === 0 ? "M" : "L"}${left + i * step} ${bottom - v * span}`)
    .join(" ");
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
                ONE FIELD, TWO OUTCOMES, AND THE WATER FALLING BETWEEN THEM.

                The same crop standing on the left and burnt on the right, with
                the water mark on the seam — which is the panel's whole question
                in one picture: this season is somewhere on that line, and the
                chart inside says where.

                Composed from two photographs rather than one, because no single
                frame of a real field shows both states; the seam is the honest
                way to put them together, and it is also the reading order —
                good on the left, what happens without water on the right.
              */}
              {p.id === "season" && (
                <span className="art-duo">
                  <i className="ad-lush" />
                  <i className="ad-dry" />
                  <span className="ad-badge">
                    <svg viewBox="0 0 40 40" aria-hidden="true">
                      <circle cx="20" cy="20" r="17.5" fill="rgba(12,10,8,0.66)" />
                      <path
                        d="M20 7c4.4 5.6 6.6 8.9 6.6 11.8a6.6 6.6 0 0 1-13.2 0C13.4 15.9 15.6 12.6 20 7Z"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="1.9"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M20 27v6.4M16.4 30l3.6 3.4 3.6-3.4"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </span>
              )}
              {/*
                A SHELF OF PAST SEASONS, ONE PULLED OUT.

                Drawn rather than photographed, and one figure rather than four,
                because the subject here is not a field at all — it is the
                comparison. No photograph can say "we looked through thirty
                years and this one matches", and four photographs of four
                weathers said something else entirely: that the panel is about
                what the weather did, when it is about which past year it did it
                in.

                Each card carries its own season shape, because that is what is
                actually being matched on — not the totals, the trajectory.
              */}
              {p.id === "analog" && (
                <span className="art-years">
                  <svg viewBox="0 0 300 92" preserveAspectRatio="xMidYMid slice">
                    {YEAR_CURVES.map((curve, i) => {
                      const x = CARD_X0 + i * CARD_PITCH;
                      const match = i === MATCHED_CARD;
                      // The matched card is taller at both ends, so it reads as
                      // lifted out of the row rather than merely coloured in.
                      const top = match ? 6 : 15;
                      const h = match ? 80 : 62;
                      return (
                        <g key={i}>
                          <rect
                            x={x}
                            y={top}
                            width={CARD_W}
                            height={h}
                            rx={3}
                            fill="var(--surface-raised)"
                            stroke={match ? "var(--series-1)" : "var(--border-strong)"}
                            strokeWidth={match ? 1.8 : 1}
                          />
                          {/* The calendar-page header band that says "a year". */}
                          <path
                            d={
                              `M${x} ${top + 3}a3 3 0 0 1 3-3h${CARD_W - 6}` +
                              `a3 3 0 0 1 3 3v${HEADER_H}H${x}z`
                            }
                            fill={match ? "var(--series-1)" : "var(--band-inner)"}
                          />
                          <path
                            d={curvePath(curve, x, top, h)}
                            fill="none"
                            stroke={match ? "var(--series-1)" : "var(--text-muted)"}
                            strokeWidth={match ? 2.2 : 1.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </g>
                      );
                    })}
                  </svg>
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
