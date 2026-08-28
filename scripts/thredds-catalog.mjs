/**
 * Which gridMET aggregated files THREDDS actually serves, and their grid
 * variable names.
 *
 * The Climatology Lab's file naming does not match Earth Engine's band naming:
 * EE calls grass reference ET `eto`, but the THREDDS file is named differently.
 * Probing candidates directly is quicker than finding the catalog index.
 */
const CANDIDATES = ["pr", "tmmx", "tmmn", "pet", "eto", "etr", "srad", "rmax", "rmin", "vs", "th"];

for (const v of CANDIDATES) {
  const url = `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${v}_1979_CurrentYear_CONUS.nc/dataset.xml`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  ${v.padEnd(6)} ${res.status}`);
      continue;
    }
    const xml = await res.text();
    const grid = xml.match(/<grid name="([^"]+)"/)?.[1] ?? "?";
    const end = xml.match(/<end>([^<]+)<\/end>/)?.[1] ?? "?";
    console.log(`  ${v.padEnd(6)} OK   ${grid.padEnd(34)} through ${end.slice(0, 10)}`);
  } catch (e) {
    console.log(`  ${v.padEnd(6)} ERR  ${e.message}`);
  }
}
