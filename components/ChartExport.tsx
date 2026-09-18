"use client";

import { useState } from "react";
import { downloadChartPng, type FigureMeta } from "@/lib/export/figure";
import { downloadCsv } from "@/lib/export/csv";
import { trackOnce } from "@/lib/analytics/client";

/**
 * Download buttons for a chart: the data behind it, and the figure itself.
 *
 * Both export WHAT IS CURRENTLY ON SCREEN — the chosen variable, units, years
 * and view. The callbacks are passed in rather than the data, so a chart cannot
 * accidentally export a stale snapshot: they are evaluated at click time.
 *
 * Errors surface in the button instead of a console nobody reads. A download
 * that silently does nothing is the most confusing possible failure, because
 * the browser gives no feedback either way.
 */

interface Props {
  /** The element wrapping the chart's <svg>. */
  chartRef: React.RefObject<HTMLDivElement>;
  /** Built at click time so it always reflects current state. */
  buildCsv: () => { csv: string; filename: string };
  buildFigure: () => { meta: FigureMeta; filename: string };
  /**
   * Which chart these buttons belong to, for the feature log — "season" or
   * "trend". A download is the strongest signal on the site that somebody is
   * doing real work with it rather than glancing, so it is worth knowing which
   * chart earns them.
   */
  chartId: string;
}

/**
 * Output sizes, in inches at 300 dpi.
 *
 * WHY THIS EXISTS: readers said the figures were too wide to drop into a
 * manuscript. The chart is as wide as a browser window, and a journal column
 * is 3.5 inches — so the figure had to be shrunk in Word, which shrinks the
 * type with it until the axis labels are unreadable.
 *
 * Scaling the exported image cannot fix that: it changes the pixel count, not
 * the SHAPE. A 3.5-inch-wide version of a window-wide chart is the same wide
 * chart, just smaller. The fix has to re-lay-out the chart at the target
 * width, so the plot area, the ticks and the labels are arranged for that
 * shape — which is what `renderAt` below does.
 *
 * 300 dpi is the figure requirement almost every journal states.
 */
const DPI = 300;
/** CSS pixels per inch, fixed by the CSS specification. */
const CSS_PPI = 96;

const SIZES: Array<{ id: string; label: string; w: number; h: number } | { id: "screen"; label: string; w: null; h: null }> = [
  { id: "screen", label: "As on screen", w: null, h: null },
  { id: "single", label: 'Journal single column (3.5")', w: 3.5, h: 2.6 },
  { id: "onehalf", label: 'Journal 1.5 column (5")', w: 5, h: 3.4 },
  { id: "double", label: 'Journal double column (7")', w: 7, h: 4.2 },
  { id: "slide", label: 'Slide (10 x 5.6")', w: 10, h: 5.6 },
];

/**
 * Give the chart a different shape, let it re-lay-out, and hand it back.
 *
 * Recharts sizes itself from its container through a ResizeObserver, so the
 * container is resized and then we WAIT FOR THE SVG TO ACTUALLY FOLLOW rather
 * than guessing at a delay — capturing one frame early produces a figure at
 * the old shape with no error anywhere, which is precisely the class of silent
 * wrongness this file already exists to prevent.
 *
 * It is done off-screen (`position: fixed`, far left) so the page does not
 * visibly jump while a download is being prepared.
 */
async function renderAt<T>(
  el: HTMLElement,
  widthIn: number,
  heightIn: number,
  capture: () => Promise<T>
): Promise<T> {
  /*
    The requested size is the FINISHED IMAGE, not the plot inside it.

    The exporter adds a margin either side of the plot, so sizing the plot at
    3.5 inches produced a 4.0-inch image — and a reader placing that in a
    3.5-inch column scales it down by a further 12%, shrinking the type that
    this whole feature exists to keep readable. Subtracting the margin here
    means "single column" really does come out 1050 px at 300 dpi.

    Height is not treated the same way and cannot be: how tall the caption
    block ends up depends on how many lines the title and provenance wrap to,
    which is only known once they have been measured against the final width.
    The height below therefore sets the PLOT's shape, and the finished image is
    a little taller. Width is the dimension a journal specifies, so width is
    the one made exact.
  */
  const FIGURE_MARGIN_PX = 48;
  const targetW = Math.max(200, Math.round(widthIn * CSS_PPI) - FIGURE_MARGIN_PX);
  const targetH = Math.round(heightIn * CSS_PPI);
  const previous = el.getAttribute("style");

  el.style.position = "fixed";
  el.style.left = "-20000px";
  el.style.top = "0";
  el.style.zIndex = "-1";
  el.style.width = `${targetW}px`;
  el.style.height = `${targetH}px`;

  try {
    const deadline = Date.now() + 2000;
    for (;;) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const svg = el.querySelector("svg");
      const got = svg?.getBoundingClientRect().width ?? 0;
      // Within a pixel or two is a match; Recharts rounds.
      if (Math.abs(got - targetW) <= 2) break;
      if (Date.now() > deadline) {
        throw new Error(
          "The chart did not resize in time. Try again, or use “As on screen”."
        );
      }
    }

    /*
      THE BOX BEING THE RIGHT SIZE DOES NOT MEAN THE CHART IS DRAWN.

      Resizing makes Recharts re-run its entry animation, so for about a second
      and a half the lines are only partly drawn. Capturing as soon as the
      container matched produced a figure with correct axes, a correct title,
      a correct legend — and almost no data: one short fragment of one line in
      the corner. Nothing errored. It is precisely the kind of confident,
      plausible, wrong output this file exists to prevent, and it would have
      shipped as "the export is broken sometimes".

      So wait for the geometry to STOP CHANGING rather than for a fixed delay.
      Polling the path data is what actually answers "has it finished", and it
      costs nothing extra once the animation has settled.
    */
    const geometry = () =>
      [...el.querySelectorAll(".recharts-line-curve, .recharts-area-area")]
        .map((n) => n.getAttribute("d") ?? "")
        .join("|");

    let previousGeometry = "";
    let stableFrames = 0;
    const settleBy = Date.now() + 4000;
    while (Date.now() < settleBy) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = geometry();
      // An empty chart legitimately has no paths; only require stability then.
      stableFrames = now === previousGeometry ? stableFrames + 1 : 0;
      previousGeometry = now;
      if (stableFrames >= 8) break;
    }

    return await capture();
  } finally {
    // Restore whatever inline style was there, including none.
    if (previous === null) el.removeAttribute("style");
    else el.setAttribute("style", previous);
  }
}

export default function ChartExport({ chartRef, buildCsv, buildFigure, chartId }: Props) {
  const [busy, setBusy] = useState<null | "csv" | "png">(null);
  const [error, setError] = useState<string | null>(null);
  const [sizeId, setSizeId] = useState<string>("screen");

  function handleCsv() {
    setError(null);
    try {
      const { csv, filename } = buildCsv();
      downloadCsv(csv, filename);
      // Only after the download is actually handed over — recording the intent
      // would count failures as successes.
      trackOnce("export", `csv:${chartId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePng() {
    setError(null);
    if (!chartRef.current) {
      setError("The chart is not ready yet.");
      return;
    }
    setBusy("png");
    try {
      const { meta, filename } = buildFigure();
      const size = SIZES.find((s) => s.id === sizeId);
      const el = chartRef.current;

      if (!size || size.w === null || size.h === null) {
        await downloadChartPng(el, filename, meta);
      } else {
        // Scale chosen so the finished image is exactly the requested
        // physical size at 300 dpi, rather than an arbitrary multiplier.
        const scale = DPI / CSS_PPI;
        await renderAt(el, size.w, size.h, () =>
          downloadChartPng(el, filename, meta, scale)
        );
      }
      trackOnce("export", `figure:${chartId}:${sizeId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="field export-field">
      <label>Download</label>
      <div className="seg">
        <button onClick={handleCsv} disabled={busy !== null} title="The data behind this chart, as shown">
          CSV
        </button>
        <button
          onClick={handlePng}
          disabled={busy !== null}
          title="A high-resolution image of this chart, with its source and location"
        >
          {busy === "png" ? "…" : "Figure"}
        </button>
      </div>
      {/* The figure's shape, not just its resolution — see SIZES. */}
      <select
        className="export-size"
        aria-label="Figure size"
        value={sizeId}
        onChange={(e) => setSizeId(e.target.value)}
        disabled={busy !== null}
        title="Figure size. The chart is laid out again at this shape, so the labels stay readable."
      >
        {SIZES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {sizeId !== "screen" && (
        <span className="small muted" style={{ marginTop: 2 }}>
          {DPI} dpi — ready to place at that width
        </span>
      )}
      {error && (
        <span className="small" style={{ color: "var(--div-warm)", marginTop: 4 }}>
          {error}
        </span>
      )}
    </div>
  );
}
