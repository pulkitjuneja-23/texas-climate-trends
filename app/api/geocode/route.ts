import { NextResponse } from "next/server";
import { TEXAS_BOUNDS } from "@/lib/geo";

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
    if (lat && lon) {
      const params = new URLSearchParams({
        format: "jsonv2",
        lat,
        lon,
        zoom: "10",
        addressdetails: "1",
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
        headers: { "User-Agent": UA },
        next: { revalidate: 86400 },
      });
      if (!res.ok) throw new Error(`Nominatim reverse returned ${res.status}`);
      const p = (await res.json()) as NominatimPlace;
      return NextResponse.json({
        results: [
          {
            label: shortLabel(p),
            lat: Number(p.lat),
            lon: Number(p.lon),
            county: countyOf(p.address),
          },
        ],
      });
    }

    if (!q || q.trim().length < 2) {
      return NextResponse.json({ results: [] });
    }

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

    return NextResponse.json({ results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, results: [] }, { status: 502 });
  }
}
