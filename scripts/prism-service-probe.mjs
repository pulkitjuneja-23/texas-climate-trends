/**
 * What can PRISM's web service actually serve?
 *
 * PRISM was declined in August because its public service appeared to offer
 * only whole-CONUS daily rasters — a 30-year Texas archive would then cost
 * ~46,000 downloads of data that is 99% not Texas. But the current docs mention
 * a `region` parameter and netCDF output, which if real would make PRISM as
 * cheap to ingest as gridMET.
 *
 * Worth ten minutes of probing before either building it or declining it again.
 */

const DAY = "20240701";
const BASE = "https://services.nacse.org/prism/data/get";

/**
 * Candidate shapes, from the published usage docs and from how comparable
 * services are normally addressed. Only the response tells us which are real.
 */
const CANDIDATES = [
  ["whole CONUS, bil", `${BASE}/us/4km/ppt/${DAY}`],
  ["whole CONUS, nc", `${BASE}/us/4km/ppt/${DAY}?format=nc`],
  ["region=us nc", `${BASE}/us/4km/ppt/${DAY}/nc`],
  ["subset bbox", `${BASE}/us/4km/ppt/${DAY}?format=nc&bbox=-106.7,25.8,-93.4,36.6`],
  ["grib2", `${BASE}/us/4km/ppt/${DAY}?format=grib2`],
];

for (const [label, url] of CANDIDATES) {
  const t = Date.now();
  try {
    // HEAD first so a 3 MB body is not pulled just to learn the status.
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    const len = Number(head.headers.get("content-length") ?? 0);
    const type = head.headers.get("content-type") ?? "?";
    const disp = head.headers.get("content-disposition") ?? "";
    console.log(
      `${label.padEnd(20)} ${head.status}  ${((Date.now() - t) / 1000).toFixed(1)}s  ` +
        `${len ? (len / 1048576).toFixed(2) + " MB" : "size unknown"}  ${type}` +
        (disp ? `  ${disp.slice(0, 60)}` : "")
    );
  } catch (e) {
    console.log(`${label.padEnd(20)} ERR  ${e instanceof Error ? e.message : e}`);
  }
}

// The rate limit matters more than the per-file size: 30 years x 4 variables is
// ~46,000 requests if there is no regional subsetting.
console.log("\nchecking for a rate limit — 5 rapid requests for the same file:");
for (let i = 0; i < 5; i++) {
  const t = Date.now();
  const res = await fetch(`${BASE}/us/4km/ppt/${DAY}`, { method: "HEAD" });
  console.log(
    `  ${i + 1}: ${res.status} in ${((Date.now() - t) / 1000).toFixed(1)}s` +
      (res.status !== 200 ? `  ${await res.text().catch(() => "")}`.slice(0, 120) : "")
  );
}
