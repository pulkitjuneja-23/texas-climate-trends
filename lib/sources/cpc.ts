import { unzipSync, strFromU8 } from "fflate";

/**
 * NOAA Climate Prediction Center outlooks — the long-range tier.
 *
 * CPC publishes no JSON API. It publishes KMZ (zipped KML) on its GIS FTP
 * mirror, where each Placemark is a probability contour whose <name> reads
 * e.g. "50.0&#37; Chance of Above Normal Temperature". So we unzip, pull the
 * contours, and run point-in-polygon to get an outlook for THIS location
 * rather than showing the grower a national map and making them squint.
 *
 * Contours are nested (33 / 40 / 50 / 60 ...), so a point can fall inside
 * several. The most specific — highest probability — wins.
 *
 * These are PROBABILISTIC and tercile-relative. "60% chance of above normal"
 * means the odds are tilted, not that a number is being predicted. The UI must
 * present them that way; they are not forecasts of a value.
 */

const BASE = "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst";
const UA = "TexasClimateTrends/0.1 (contact via repo issues)";

export type OutlookProduct = "610temp" | "610prcp" | "814temp" | "814prcp" | "wk34temp" | "wk34prcp";

export type Tercile = "above" | "below" | "near";

export interface OutlookResult {
  product: OutlookProduct;
  label: string;
  /** Which tercile is favoured at this point. */
  tercile: Tercile;
  /** Probability in percent, e.g. 50. */
  probability: number;
  /** Raw contour label from CPC. */
  raw: string;
  /** Period the outlook is valid for, parsed from the title placemark. */
  validText: string | null;
  createdText: string | null;
}

const PRODUCT_LABELS: Record<OutlookProduct, string> = {
  "610temp": "6-10 day temperature",
  "610prcp": "6-10 day precipitation",
  "814temp": "8-14 day temperature",
  "814prcp": "8-14 day precipitation",
  wk34temp: "Week 3-4 temperature",
  wk34prcp: "Week 3-4 precipitation",
};

type Ring = Array<[number, number]>;
interface Poly {
  outer: Ring;
  holes: Ring[];
}
interface Contour {
  name: string;
  polys: Poly[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#37;/g, "%")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();
}

function parseRing(text: string): Ring {
  const ring: Ring = [];
  // "lon,lat,alt lon,lat,alt ..." whitespace separated
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    const parts = tok.split(",");
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lon, lat]);
  }
  return ring;
}

function parseKml(kml: string): Contour[] {
  const contours: Contour[] = [];
  const placemarks = kml.split(/<Placemark[\s>]/i).slice(1);

  for (const chunk of placemarks) {
    const body = chunk.split(/<\/Placemark>/i)[0] ?? "";
    const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/i);
    const name = nameMatch ? decodeEntities(nameMatch[1]) : "";
    if (!name) continue;

    const polys: Poly[] = [];
    const polyBlocks = body.split(/<Polygon[\s>]/i).slice(1);
    for (const pb of polyBlocks) {
      const pbody = pb.split(/<\/Polygon>/i)[0] ?? "";
      const outerM = pbody.match(
        /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>/i
      );
      if (!outerM) continue;
      const outer = parseRing(outerM[1]);
      if (outer.length < 3) continue;

      const holes: Ring[] = [];
      const innerRe =
        /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/innerBoundaryIs>/gi;
      let im: RegExpExecArray | null;
      while ((im = innerRe.exec(pbody)) !== null) {
        const h = parseRing(im[1]);
        if (h.length >= 3) holes.push(h);
      }
      polys.push({ outer, holes });
    }

    if (polys.length) contours.push({ name, polys });
    else contours.push({ name, polys: [] }); // title placemark carries no geometry
  }
  return contours;
}

/** Ray-casting. `pt` is [lon, lat]. */
function inRing(pt: [number, number], ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function inPoly(pt: [number, number], poly: Poly): boolean {
  if (!inRing(pt, poly.outer)) return false;
  return !poly.holes.some((h) => inRing(pt, h));
}

/** "50.0% Chance of Above Normal Temperature" -> {tercile, probability} */
function parseContourName(name: string): { tercile: Tercile; probability: number } | null {
  const pm = name.match(/([\d.]+)\s*%/);
  if (!pm) return null;
  const probability = Number(pm[1]);
  if (!Number.isFinite(probability)) return null;

  const lower = name.toLowerCase();
  let tercile: Tercile;
  if (lower.includes("above")) tercile = "above";
  else if (lower.includes("below")) tercile = "below";
  else if (lower.includes("near")) tercile = "near";
  else return null;

  return { tercile, probability };
}

export async function fetchOutlook(
  product: OutlookProduct,
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<OutlookResult | null> {
  const res = await fetch(`${BASE}/${product}_latest.kmz`, {
    signal,
    headers: { "User-Agent": UA },
    next: { revalidate: 60 * 60 * 6 },
  });
  if (!res.ok) throw new Error(`CPC ${product} returned ${res.status} ${res.statusText}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  // Inflate only the .kml, and only if its declared size is sane (a real one is
  // well under 5 MB), so a damaged or altered download cannot balloon in memory.
  const files = unzipSync(buf, {
    filter: (f) => f.name.toLowerCase().endsWith(".kml") && f.originalSize <= 20 * 1024 * 1024,
  });
  const kmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".kml"));
  if (!kmlName) throw new Error(`CPC ${product}: no .kml inside .kmz`);

  const kmlText = strFromU8(files[kmlName]);
  const contours = parseKml(kmlText);

  // The created/valid dates live on the <Document> <name>, which is NOT inside
  // a <Placemark> — so scan the whole document rather than the parsed contours.
  const titleText =
    [...kmlText.matchAll(/<name>([\s\S]*?)<\/name>/gi)]
      .map((m) => decodeEntities(m[1]))
      .find((n) => /Outlook/i.test(n) && /Valid/i.test(n)) ?? "";
  const validText = titleText.match(/Valid:\s*([\d/]+\s*-\s*[\d/]+)/i)?.[1] ?? null;
  const createdText = titleText.match(/Created:\s*([\d/]+)/i)?.[1] ?? null;

  const pt: [number, number] = [lon, lat];
  let best: OutlookResult | null = null;

  for (const c of contours) {
    const parsed = parseContourName(c.name);
    if (!parsed || !c.polys.length) continue;
    if (!c.polys.some((p) => inPoly(pt, p))) continue;

    // Nested contours: keep the most specific (highest probability).
    if (!best || parsed.probability > best.probability) {
      best = {
        product,
        label: PRODUCT_LABELS[product],
        tercile: parsed.tercile,
        probability: parsed.probability,
        raw: c.name,
        validText,
        createdText,
      };
    }
  }

  // Point inside the domain but in no contour = CPC "Equal Chances".
  if (!best) {
    return {
      product,
      label: PRODUCT_LABELS[product],
      tercile: "near",
      probability: 33,
      raw: "Equal Chances (no tilt in the odds)",
      validText,
      createdText,
    };
  }
  return best;
}

export async function fetchAllOutlooks(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<OutlookResult[]> {
  const products: OutlookProduct[] = ["610temp", "610prcp", "814temp", "814prcp", "wk34temp", "wk34prcp"];
  const settled = await Promise.allSettled(
    products.map((p) => fetchOutlook(p, lat, lon, signal))
  );
  return settled
    .filter(
      (s): s is PromiseFulfilledResult<OutlookResult | null> => s.status === "fulfilled"
    )
    .map((s) => s.value)
    .filter((v): v is OutlookResult => v !== null);
}
