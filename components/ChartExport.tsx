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

export default function ChartExport({ chartRef, buildCsv, buildFigure, chartId }: Props) {
  const [busy, setBusy] = useState<null | "csv" | "png">(null);
  const [error, setError] = useState<string | null>(null);

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
      await downloadChartPng(chartRef.current, filename, meta);
      trackOnce("export", `figure:${chartId}`);
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
      {error && (
        <span className="small" style={{ color: "var(--div-warm)", marginTop: 4 }}>
          {error}
        </span>
      )}
    </div>
  );
}
