/**
 * What a downloaded file has to say about itself.
 *
 * A CSV or figure that leaves this app anonymous is a number without a source,
 * and the entire argument of the project is that the source changes the answer
 * — measured at Waco, annual rainfall differs by six inches between datasets
 * for the same field. So every export names the dataset, the exact grid cell
 * actually read, and when it was taken.
 *
 * `readAt` matters more than it looks: the pin is snapped to the source's own
 * grid, so a gridMET export is a 4 km cell and a NASA POWER one is 55 km. A file
 * carrying only the clicked coordinates would imply a precision that was never
 * there.
 */
import { formatDate } from "@/lib/format/date";

export interface ExportContext {
  /** Human label for the spot, e.g. "Blackland cropland" or a searched address. */
  placeName?: string | null;
  /** What the user asked for. */
  lat: number;
  lon: number;
  /** The grid cell centre actually read, after snapping. */
  readAt?: { lat: number; lon: number } | null;
  /** Display name of the dataset, e.g. "gridMET (4 km)". */
  sourceName?: string | null;
  /** Short id for the filename, e.g. "gridmet". */
  sourceId?: string | null;
}

/** ISO date, for filenames and the CSV provenance block. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The `#` comment block at the top of every CSV. */
export function csvHeader(ctx: ExportContext | undefined, extra: string[] = []): string[] {
  /*
    The NAME has changed twice; the URL never has. The deployment is still
    texas-climate-trends.vercel.app, and printing anything else in an exported
    file would send the reader to a page that does not exist.
  */
  const lines = [
    "Texas Weather Explorer — https://texas-climate-trends.vercel.app",
  ];
  if (!ctx) return [...lines, ...extra, `Exported: ${today()}`];

  if (ctx.placeName) lines.push(`Location: ${ctx.placeName}`);
  lines.push(`Requested point: ${ctx.lat.toFixed(4)}, ${ctx.lon.toFixed(4)}`);
  if (ctx.readAt) {
    lines.push(
      `Grid cell actually read: ${ctx.readAt.lat.toFixed(4)}, ${ctx.readAt.lon.toFixed(4)}`
    );
  }
  if (ctx.sourceName) lines.push(`Data source: ${ctx.sourceName}`);
  lines.push(...extra);
  lines.push(`Exported: ${today()}`);
  return lines;
}

/** The single provenance line printed under an exported figure. */
export function figureFooter(ctx: ExportContext | undefined, extra?: string): string {
  const bits: string[] = [];
  if (ctx?.sourceName) bits.push(ctx.sourceName);
  if (ctx?.readAt) bits.push(`${ctx.readAt.lat.toFixed(3)}, ${ctx.readAt.lon.toFixed(3)}`);
  else if (ctx) bits.push(`${ctx.lat.toFixed(3)}, ${ctx.lon.toFixed(3)}`);
  if (extra) bits.push(extra);
  // The name alone under a figure — a printed caption has no room for the URL,
  // and the CSV block above carries it.
  bits.push("Texas Weather Explorer");
  /*
    The readable form, not ISO. This line is printed under a picture that ends
    up in a slide or a report, where it is read by a person — and the site's
    convention is a spelled-out month. The CSV block above keeps ISO, because
    everything else in that file is ISO and a spreadsheet reads it.
  */
  bits.push(formatDate(today()));
  return bits.join("  ·  ");
}
