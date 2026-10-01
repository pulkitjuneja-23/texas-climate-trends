import { NextResponse } from "next/server";
import { TEXAS_BOUNDS, validateLatLon } from "@/lib/geo";
import { enforceLimit, spaced, rejection, RequestRejected, LIMITS } from "@/lib/api/guard";

export const runtime = "nodejs";
export const revalidate = 86400;

/**
 * GET /api/geocode?q=  — forward search, Texas-biased
 * GET /api/geocode?lat=&lon=  — reverse, for map clicks
 *
 * Proxied server-side rather than called from the browser so we can send the
 * identifying User-Agent Nominatim's usage policy requires, and so the browser
 * isn't hammering a community service directly on every keystroke.
 */

const UA = "TexasClimateTrends/0.1 (agricultural decision support; contact via repo issues)";

/**
 * Nominatim's usage policy, enforced HERE rather than only in the browser.
 *
 * Submit-only search and per-query caching live in LocationPicker, but anyone
 * can call this route directly, and every call carries the UA above. Unlimited,
 * it let any script bulk-geocode under the project's name — and a block from
 * Nominatim would break town search for every grower. So: a short query cap,
 * a per-visitor limit, and at most one upstream call per second per instance.
 */
const MAX_QUERY_CHARS = 200;

async function nominatimSlot(): Promise<void> {
  // Waits up to 6 s for a turn; a person will wait that long for a search.
  if (!(await spaced("nominatim", 1000, 6000))) {
    throw new RequestRejected("Search is busy. Please try again in a few seconds.", 429);
  }
}

/**
 * One Nominatim request per distinct question, however many people ask it.
 *
 * In a room where everyone searches the same town, or clicks near the same
 * farm, the answer is (1) served from memory if this instance already has it,
 * or (2) shared with whoever is already waiting for it, so the crowd costs
 * Nominatim ONE request and nobody else queues for a turn. Without (2), thirty
 * simultaneous searches for "Temple, TX" each waited for their own one-second
 * slot and only eight were answered. Place names change rarely, so answers are
 * kept a day.
 */
const ANSWER_TTL_MS = 24 * 3600 * 1000;
const MAX_ANSWERS = 2000;
const answers = new Map<string, { at: number; body: unknown }>();
const pending = new Map<string, Promise<unknown>>();

async function lookup(key: string, fetchBody: () => Promise<unknown>): Promise<unknown> {
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < ANSWER_TTL_MS) return hit.body;

  const waiting = pending.get(key);
  if (waiting) return waiting;

  const work = (async () => {
    await nominatimSlot();
    const body = await fetchBody();
    if (answers.size >= MAX_ANSWERS) {
      const oldest = answers.keys().next().value;
      if (oldest !== undefined) answers.delete(oldest);
    }
    answers.set(key, { at: Date.now(), body });
    return body;
  })();
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

function countyOf(a?: Record<string, string>): string | undefined {
  return a?.county;
}

/**
 * Trim Nominatim's very long display names to something readable.
 *
 * The street line is kept when Nominatim returns one. An earlier version threw
 * it away and showed only city + county, so searching a specific address gave
 * back a list of towns and the user could not tell which result was actually
 * their place.
 */
function shortLabel(p: NominatimPlace): string {
  const a = p.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const place = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.municipality;
  const county = a.county?.replace(/ County$/, "");
  const state = a.state === "Texas" ? "TX" : a.state;

  const parts = [
    street || place,
    street && place ? place : null,
    county ? `${county} Co.` : null,
    state,
  ].filter(Boolean) as string[];

  if (parts.length) return parts.join(", ");
  return p.display_name.split(",").slice(0, 3).join(",").trim();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");

  try {
    enforceLimit(req, "geocode", LIMITS.geocode);

    if (lat && lon) {
      // Map clicks may fall just outside Texas (the page then says so), so
      // reverse lookups are not bounded to Texas, only checked to be numbers.
      const point = validateLatLon(lat, lon);
      // Rounded to ~100 m: close enough that clicks on one farm share an
      // answer, fine enough that the county name is right next to a county line.
      const key = `r:${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
      const body = await lookup(key, async () => {
        const params = new URLSearchParams({
          format: "jsonv2",
          lat: point.lat.toFixed(5),
          lon: point.lon.toFixed(5),
          zoom: "10",
          addressdetails: "1",
        });
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
          headers: { "User-Agent": UA },
          next: { revalidate: 86400 },
        });
        if (!res.ok) throw new Error(`Nominatim reverse returned ${res.status}`);
        const p = (await res.json()) as NominatimPlace;
        return {
          results: [
            {
              label: shortLabel(p),
              lat: Number(p.lat),
              lon: Number(p.lon),
              county: countyOf(p.address),
            },
          ],
        };
      });
      return NextResponse.json(body);
    }

    if (!q || q.trim().length < 2) {
      return NextResponse.json({ results: [] });
    }
    if (q.length > MAX_QUERY_CHARS) {
      throw new RequestRejected("That search is too long.");
    }

    const body = await lookup(`q:${q.trim().toLowerCase()}`, async () => {
      const params = new URLSearchParams({
        format: "jsonv2",
        q: q.trim(),
        addressdetails: "1",
        limit: "8",
        countrycodes: "us",
        // Bias toward Texas without hard-excluding just-over-the-line fields.
        viewbox: `${TEXAS_BOUNDS.minLon},${TEXAS_BOUNDS.maxLat},${TEXAS_BOUNDS.maxLon},${TEXAS_BOUNDS.minLat}`,
        bounded: "0",
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "User-Agent": UA },
        next: { revalidate: 86400 },
      });
      if (!res.ok) throw new Error(`Nominatim search returned ${res.status}`);

      const places = (await res.json()) as NominatimPlace[];
      const results = places
        .map((p) => ({
          label: shortLabel(p),
          lat: Number(p.lat),
          lon: Number(p.lon),
          county: countyOf(p.address),
          state: p.address?.state,
        }))
        // Texas hits first, but keep the rest — the tool works anywhere POWER does.
        .sort((a, b) => Number(b.state === "Texas") - Number(a.state === "Texas"));
      return { results };
    });
    return NextResponse.json(body);
  } catch (e) {
    const refused = rejection(e);
    if (refused) {
      return NextResponse.json({ error: refused.error, results: [] }, { status: refused.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, results: [] }, { status: 502 });
  }
}
