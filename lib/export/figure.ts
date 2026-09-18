/**
 * Turning a live Recharts SVG into a high-resolution PNG.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS EXISTS TO AVOID
 * ---------------------------------------------------------------------------
 * Serialising the chart's SVG and rasterising it looks like three lines of
 * code, and produces a black or blank rectangle. Two reasons, both silent:
 *
 * 1. EVERY COLOUR IN THIS APP IS A CSS CUSTOM PROPERTY - `var(--series-1)`,
 *    `var(--gridline)`, and so on. Those are resolved by the document's
 *    stylesheet. The moment the SVG is serialised and handed to an <img> it is
 *    a separate document with no stylesheet, so every var() resolves to
 *    nothing. Recharts' own class-based styling disappears the same way.
 *
 * 2. Fonts and stroke widths come from inherited CSS, which likewise does not
 *    survive.
 *
 * So the clone is walked node by node against the live element and the COMPUTED
 * value of every presentational property is written onto it inline. That is the
 * whole trick, and it is why this file is longer than it looks like it should
 * be.
 *
 * ---------------------------------------------------------------------------
 * WHY PNG RATHER THAN SVG
 * ---------------------------------------------------------------------------
 * SVG is the better format on paper, but it lands in Word and PowerPoint badly
 * and often not at all. A 3x PNG pastes anywhere and prints cleanly, which is
 * what a figure in a report actually needs.
 *
 * The exported image carries its own title, location, source and date. A chart
 * that leaves this app anonymous would undercut the point the app is making -
 * that which dataset you chose changes the answer.
 */

import { downloadBlob } from "./csv";

/** Written inline onto the clone. Anything omitted here is lost on export. */
const INLINED_PROPERTIES = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "visibility",
  "display",
  "shape-rendering",
] as const;

function inlineStyles(source: Element, clone: Element): void {
  const computed = window.getComputedStyle(source);
  let css = "";
  for (const prop of INLINED_PROPERTIES) {
    const v = computed.getPropertyValue(prop);
    // "none" on fill/stroke is meaningful and must be kept; empty is not.
    if (v) css += `${prop}:${v};`;
  }
  (clone as SVGElement).setAttribute("style", css);

  const sKids = source.children;
  const cKids = clone.children;
  for (let i = 0; i < sKids.length && i < cKids.length; i++) {
    inlineStyles(sKids[i], cKids[i]);
  }
}

/**
 * One legend entry. `varName` is a CSS custom property NAME, not a colour —
 * it is resolved against the live chart so the figure matches the theme on
 * screen.
 */
export interface LegendItem {
  label: string;
  varName: string;
  kind: "line" | "dash" | "band";
}

export interface FigureMeta {
  /** Bold headline, e.g. "Season tracker — Rainfall". */
  title: string;
  /** Location and settings, e.g. "31.30, -97.40 · accumulated · in". */
  subtitle: string;
  /** Provenance, e.g. "gridMET (4 km) · Texas Weather Explorer · August 28, 2026". */
  footer: string;
  /**
   * Drawn under the plot.
   *
   * Necessary rather than decorative: the on-screen legend is HTML sitting
   * OUTSIDE the SVG, so it does not survive serialisation. Without redrawing
   * it, an exported figure shows two grey bands with nothing to say what they
   * are — and those bands are the context that makes a single year mean
   * anything. A figure has to stand alone once it is in someone's report.
   */
  legend?: LegendItem[];
}

export interface FigureOptions {
  /**
   * Pixel multiplier. 4 puts a screen-width chart comfortably past 300 dpi at
   * report width, and the SVG is rasterised at that size rather than upscaled,
   * so the cost is file size only — not softness.
   */
  scale?: number;
  /** Painted behind the chart — an SVG is transparent, and a dark-mode chart on
   *  transparency is unreadable in a white document. */
  background?: string;
  /** Text colour for the title block. */
  foreground?: string;
  muted?: string;
}

/**
 * Render an on-screen SVG to a PNG Blob.
 *
 * Throws rather than returning null, so the caller can tell the user something
 * went wrong instead of silently handing them nothing.
 */
export async function svgToPngBlob(
  svg: SVGSVGElement,
  meta: FigureMeta,
  opts: FigureOptions = {}
): Promise<Blob> {
  const scale = opts.scale ?? 4;
  const background = opts.background ?? "#ffffff";
  const foreground = opts.foreground ?? "#111111";
  const muted = opts.muted ?? "#666666";

  const rect = svg.getBoundingClientRect();
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);
  if (!w || !h) throw new Error("The chart has no size on screen yet.");

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  /**
   * THE SVG IS GIVEN ITS FULL OUTPUT SIZE, NOT THE ON-SCREEN SIZE.
   *
   * This is what makes the export sharp, and getting it wrong is subtle: an
   * <img> rasterises an SVG once, at the size the SVG declares. Declaring the
   * on-screen 700x420 and then drawing it into a 3x canvas rasterises at
   * 700x420 and BITMAP-SCALES that up — so the figure came out soft, exactly as
   * a screenshot would. Nothing errors; it just looks mediocre.
   *
   * Declaring width/height at the output size while keeping the viewBox at the
   * original coordinates makes the browser rasterise the vector at full
   * resolution instead. Text and lines are then genuinely crisp rather than
   * enlarged pixels.
   */
  clone.setAttribute("width", String(w * scale));
  clone.setAttribute("height", String(h * scale));
  clone.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const svgText = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const img = new Image();
    // Not strictly required for a same-origin blob, but harmless and it makes
    // the intent explicit if this ever loads from elsewhere.
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("The chart image could not be rendered."));
      img.src = svgUrl;
    });

    /*
      EVERYTHING AROUND THE PLOT IS MEASURED AND WRAPPED, NOT PLACED AT FIXED
      HEIGHTS.

      This used to assume a chart roughly as wide as a browser window, so the
      title, the provenance line and the legend were each drawn as one
      unwrapped row at a fixed y. Once a reader can ask for a 3.5-inch
      single-column figure — which is the whole point of the size control —
      every one of those runs off the edge, and `fillText` clips silently
      rather than failing. A figure that loses its own source line is exactly
      the outcome this provenance block exists to prevent.

      So the text is wrapped to the plot width first, the heights are derived
      from how many lines that produced, and the canvas is sized last.
    */
    const padX = 24;
    const font = `system-ui, -apple-system, "Segoe UI", sans-serif`;

    /*
      TYPE SCALES WITH THE FIGURE, or a narrow one is mostly caption.

      The sizes below were chosen against a browser-width chart. Held fixed,
      they do not merely look large on a 3.5-inch single-column figure — the
      title, subtitle and provenance line each wrap to two or three rows, and
      the block of text around the plot grew TALLER than the plot itself. The
      first single-column export measured 1200 x 1318: a portrait figure, for a
      request that was about fitting a column width.

      Shrinking with the width keeps the proportions a reader expects. The
      floor matters as much as the ratio: at 300 dpi a 12 px face prints at
      about 9 pt and a 8.2 px face at about 6 pt, which is the smallest most
      journals accept, so the scale is not allowed below 0.68.
    */
    const ts = Math.max(0.68, Math.min(1, w / 700));
    const px = (n: number) => Math.round(n * ts * 10) / 10;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser would not provide a drawing canvas.");

    /** Greedy word wrap. Returns at least one line for a non-empty string. */
    const wrap = (text: string, maxWidth: number): string[] => {
      if (!text) return [];
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      if (line) lines.push(line);
      return lines;
    };

    // --- measure (before the canvas is sized; sizing it resets the context) ---
    ctx.font = `600 ${px(19)}px ${font}`;
    const titleLines = meta.title ? wrap(meta.title, w) : [];
    ctx.font = `${px(13)}px ${font}`;
    const subLines = meta.subtitle ? wrap(meta.subtitle, w) : [];
    ctx.font = `${px(12)}px ${font}`;
    const footerLines = meta.footer ? wrap(meta.footer, w) : [];

    const SWATCH = Math.round(16 * ts);
    const legendRows: LegendItem[][] = [];
    if (meta.legend?.length) {
      let row: LegendItem[] = [];
      let x = 0;
      for (const item of meta.legend) {
        const itemW = SWATCH + 6 * ts + ctx.measureText(item.label).width + 18 * ts;
        if (row.length && x + itemW > w) {
          legendRows.push(row);
          row = [];
          x = 0;
        }
        row.push(item);
        x += itemW;
      }
      if (row.length) legendRows.push(row);
    }

    const TITLE_LH = px(24);
    const SUB_LH = px(17);
    const FOOT_LH = px(16);
    const LEGEND_LH = px(20);

    const padTop = titleLines.length
      ? px(10) + titleLines.length * TITLE_LH + subLines.length * SUB_LH + px(8)
      : px(16);
    const legendH = legendRows.length ? legendRows.length * LEGEND_LH + px(6) : 0;
    const padBottom =
      legendH + (footerLines.length ? footerLines.length * FOOT_LH + px(14) : px(16));

    canvas.width = (w + padX * 2) * scale;
    canvas.height = (h + padTop + padBottom) * scale;

    // --- draw ---
    ctx.scale(scale, scale);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w + padX * 2, h + padTop + padBottom);

    ctx.textBaseline = "alphabetic";
    let y = px(10);
    if (titleLines.length) {
      ctx.fillStyle = foreground;
      ctx.font = `600 ${px(19)}px ${font}`;
      for (const line of titleLines) {
        y += TITLE_LH;
        ctx.fillText(line, padX, y);
      }
      ctx.fillStyle = muted;
      ctx.font = `${px(13)}px ${font}`;
      for (const line of subLines) {
        y += SUB_LH;
        ctx.fillText(line, padX, y);
      }
    }

    ctx.drawImage(img, padX, padTop, w, h);

    let below = h + padTop;
    if (legendRows.length) {
      ctx.font = `${px(12)}px ${font}`;
      ctx.textBaseline = "middle";
      for (const row of legendRows) {
        const rowY = below + LEGEND_LH / 2 + 3 * ts;
        let x = padX;
        for (const item of row) {
          if (item.kind === "band") {
            ctx.fillStyle = item.varName;
            ctx.fillRect(x, rowY - 5 * ts, SWATCH, 10 * ts);
          } else {
            ctx.strokeStyle = item.varName;
            ctx.lineWidth = 2.5 * ts;
            ctx.setLineDash(item.kind === "dash" ? [4 * ts, 3 * ts] : []);
            ctx.beginPath();
            ctx.moveTo(x, rowY);
            ctx.lineTo(x + SWATCH, rowY);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          x += SWATCH + 6 * ts;
          ctx.fillStyle = muted;
          ctx.fillText(item.label, x, rowY);
          x += ctx.measureText(item.label).width + 18 * ts;
        }
        below += LEGEND_LH;
      }
      below += px(6);
      ctx.textBaseline = "alphabetic";
    }

    if (footerLines.length) {
      ctx.fillStyle = muted;
      ctx.font = `${px(12)}px ${font}`;
      let fy = below + 4 * ts;
      for (const line of footerLines) {
        fy += FOOT_LH;
        ctx.fillText(line, padX, fy);
      }
    }

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))),
        "image/png"
      )
    );
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/**
 * Find the chart SVG inside a wrapper and save it.
 *
 * Reads the palette off the live element so the exported figure matches the
 * theme on screen — exporting a dark chart onto white would leave pale series
 * lines invisible.
 */
export async function downloadChartPng(
  container: HTMLElement,
  filename: string,
  meta: FigureMeta,
  scale = 4
): Promise<void> {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("No chart was found to export.");

  const styles = window.getComputedStyle(container);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  /**
   * Resolve the legend's CSS custom properties against the live chart.
   *
   * Canvas has no idea what `var(--series-1)` means — unlike the SVG, which at
   * least fails visibly. Here it would silently draw nothing. Resolving against
   * the container also means the exported legend matches whichever theme is on
   * screen.
   */
  const resolved: FigureMeta = {
    ...meta,
    legend: meta.legend?.map((item) => ({
      ...item,
      varName: item.varName.startsWith("--")
        ? read(item.varName, "#888888")
        : item.varName,
    })),
  };

  const blob = await svgToPngBlob(svg as SVGSVGElement, resolved, {
    scale,
    background: read("--surface", "#ffffff"),
    foreground: read("--text-primary", "#111111"),
    muted: read("--text-muted", "#666666"),
  });

  downloadBlob(blob, filename);
}
