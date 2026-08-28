/**
 * Squeezing redundancy out of a stored year — and putting it back exactly.
 *
 * Measured on a real gridMET year: 33,415 bytes as fetched, 21,617 after this,
 * a 35% saving with nothing lost. That is the difference between roughly 1,700
 * and 2,600 cached locations inside Supabase's free 500 MB.
 *
 * TWO REDUNDANT FIELDS
 *
 *   origin  Identical on all 366 rows of a year — it is implied by the cache
 *           key. Stored once on the entry instead of 366 times. (For airport
 *           stations it carries the station id, e.g. "stations:ACT", so the
 *           actual string is preserved rather than reconstructed from the
 *           source name.)
 *
 *   tmean   USUALLY the midpoint of tmax and tmin, but NOT ALWAYS. NASA POWER
 *           serves T2M, a genuinely independent reanalysis mean that differs
 *           from (tmax+tmin)/2. So it is dropped only where it demonstrably
 *           equals the midpoint, and kept verbatim where it does not. Dropping
 *           it blindly would silently replace a real measurement with an
 *           approximation of it.
 *
 * WHAT IS DELIBERATELY *NOT* DONE
 * Rounding temperatures to one decimal. It saves 3.3% and costs real
 * resolution: gridMET is stored in Kelvin at 0.1 K steps, so subtracting 273.15
 * puts every true value on .05/.15/.../.95 and the second decimal carries data.
 * See lib/sources/precision.ts for what IS safe to round and why.
 */

import type { DailyRecord } from "@/lib/types";

/**
 * The midpoint, at the same 2-decimal precision the sources round to.
 *
 * Deliberately inlined rather than importing `q` from lib/sources/precision, so
 * this module has no runtime imports at all and can be exercised directly.
 */
function midpoint(tmax: number | null, tmin: number | null): number | null {
  if (tmax === null || tmin === null) return null;
  return Math.round(((tmax + tmin) / 2) * 100) / 100;
}

export interface EncodedYear {
  records: Omit<DailyRecord, "origin">[];
  /** The single `origin` shared by every row, if there is one. */
  origin: string | null;
}

/**
 * Strip what can be rebuilt. Returns the records plus the origin lifted out of
 * them — or the records untouched if the year holds more than one origin, which
 * would make a single lifted value a lie.
 */
export function encodeYear(records: DailyRecord[]): EncodedYear {
  const origins = new Set(records.map((r) => r.origin).filter(Boolean));
  const single = origins.size === 1 ? ([...origins][0] as string) : null;

  const out = records.map((r) => {
    const slim: Record<string, unknown> = { ...r };
    if (single) delete slim.origin;
    // Only when it really is the midpoint — see the note above about T2M.
    if (r.tmean !== null && r.tmean === midpoint(r.tmax, r.tmin)) delete slim.tmean;
    return slim as Omit<DailyRecord, "origin">;
  });

  return { records: out, origin: single };
}

/**
 * Rebuild full records from a stored year.
 *
 * Tolerant by design: an entry written before this encoding existed still has
 * both fields present, and passes through unchanged.
 */
export function decodeYear(
  records: Omit<DailyRecord, "origin">[],
  origin: string | null
): DailyRecord[] {
  return records.map((r) => {
    const full = { ...r } as DailyRecord;
    if (full.origin === undefined && origin) full.origin = origin;

    /**
     * ABSENT and NULL mean different things here, and the difference matters.
     *
     * Absent = encodeYear removed it because it was the midpoint, so rebuild it.
     * Explicitly null = the source said it had no mean temperature that day, and
     * NASA POWER can report exactly that while still having tmax and tmin.
     * Treating null as "missing" would invent a measurement the source declined
     * to make. JSON preserves the distinction, so honour it.
     */
    if (full.tmean === undefined) full.tmean = midpoint(full.tmax, full.tmin);
    return full;
  });
}
