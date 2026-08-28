/**
 * CSV export for the charts.
 *
 * WHAT GETS EXPORTED IS WHAT IS ON SCREEN — the chosen variable, the chosen
 * units, the chosen years, the chosen view. A download that quietly gave metric
 * when the screen said inches, or daily values when the screen showed
 * accumulation, would be worse than no download at all: the number would be
 * wrong in a spreadsheet, far from anything that could correct it.
 *
 * PROVENANCE TRAVELS WITH THE NUMBERS. Every file opens with commented lines
 * naming the source, the exact grid cell read, the units and the date. This is
 * the whole argument of the project — that dataset choice measurably changes
 * the answer — so a file that leaves the app anonymous would undercut it. `#`
 * is the conventional comment marker: R's read.csv takes `comment.char="#"`,
 * pandas takes `comment='#'`, and Excel simply shows them as leading rows.
 */

/** A value that can sit in a CSV cell. */
export type CsvValue = string | number | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/**
 * Quote only when needed, and double any embedded quotes — RFC 4180.
 *
 * A stray comma inside an unquoted field silently shifts every later column,
 * which is the kind of corruption nobody notices until a model is trained on it.
 */
function cell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv<T>(
  rows: T[],
  columns: Array<CsvColumn<T>>,
  meta: string[] = []
): string {
  const lines: string[] = meta.map((m) => `# ${m}`);
  lines.push(columns.map((c) => cell(c.header)).join(","));
  for (const r of rows) {
    lines.push(columns.map((c) => cell(c.value(r))).join(","));
  }
  // Trailing newline: without it some tools drop or mangle the final row.
  return lines.join("\r\n") + "\r\n";
}

/**
 * Hand a Blob to the browser as a file.
 *
 * The object URL is revoked on the next frame rather than immediately — Safari
 * has been observed cancelling the download when the URL is freed in the same
 * tick as the click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

export function downloadCsv(csv: string, filename: string): void {
  // The BOM is deliberate: without it Excel on Windows reads UTF-8 as the ANSI
  // codepage and turns degree signs and en-dashes into mojibake. Every other
  // tool skips it.
  downloadBlob(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }), filename);
}

/** Safe, readable filename stem: "waco-tx_rainfall_gridmet_2026-08-28". */
export function slug(...parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .map((p) =>
      String(p)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join("_");
}
