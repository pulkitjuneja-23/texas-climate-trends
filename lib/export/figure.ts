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

    // Room above for the title block, and below for the legend and provenance.
    const padX = 24;
    const padTop = meta.title ? 74 : 16;
    const legendH = meta.legend?.length ? 26 : 0;
    const padBottom = (meta.footer ? 40 : 16) + legendH;

    const canvas = document.createElement("canvas");
    canvas.width = (w + padX * 2) * scale;
    canvas.height = (h + padTop + padBottom) * scale;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser would not provide a drawing canvas.");
    ctx.scale(scale, scale);

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w + padX * 2, h + padTop + padBottom);

    const font = `system-ui, -apple-system, "Segoe UI", sans-serif`;
    if (meta.title) {
      ctx.fillStyle = foreground;
      ctx.font = `600 19px ${font}`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(meta.title, padX, 32);

      ctx.fillStyle = muted;
      ctx.font = `13px ${font}`;
      ctx.fillText(meta.subtitle, padX, 54);
    }

    ctx.drawImage(img, padX, padTop, w, h);

    if (meta.legend?.length) {
      let x = padX;
      const y = h + padTop + 16;
      ctx.font = `12px ${font}`;
      ctx.textBaseline = "middle";

      for (const item of meta.legend) {
        const swatch = 16;
        if (item.kind === "band") {
          ctx.fillStyle = item.varName;
          ctx.fillRect(x, y - 5, swatch, 10);
        } else {
          ctx.strokeStyle = item.varName;
          ctx.lineWidth = 2.5;
          ctx.setLineDash(item.kind === "dash" ? [4, 3] : []);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + swatch, y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        x += swatch + 6;

        ctx.fillStyle = muted;
        ctx.fillText(item.label, x, y);
        x += ctx.measureText(item.label).width + 18;
      }
      ctx.textBaseline = "alphabetic";
    }

    if (meta.footer) {
      ctx.fillStyle = muted;
      ctx.font = `12px ${font}`;
      ctx.fillText(meta.footer, padX, h + padTop + legendH + 26);
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
