/**
 * Inspect a real NCSS response before writing a parser for it.
 *
 * The NetCDF-3 spec allows several layouts, and which one we get changes the
 * reader completely — in particular whether `day` is the UNLIMITED dimension,
 * because unlimited-dimension variables are stored as interleaved records
 * rather than one contiguous block. Guessing that wrong produces data that
 * parses without error and is silently scrambled.
 *
 * Run: node scripts/netcdf-probe.mjs
 */
const URL_ =
  "https://thredds.northwestknowledge.net/thredds/ncss/agg_met_pr_1979_CurrentYear_CONUS.nc" +
  "?var=precipitation_amount&north=32.0&south=31.8&west=-97.5&east=-97.3" +
  "&time_start=2024-01-01T00:00:00Z&time_end=2024-01-05T00:00:00Z&accept=netcdf";

const buf = Buffer.from(await (await fetch(URL_)).arrayBuffer());
console.log(`${buf.length} bytes\n`);

let p = 0;
const i32 = () => {
  const v = buf.readInt32BE(p);
  p += 4;
  return v;
};
/** Strings are length-prefixed and padded to a 4-byte boundary. */
const str = () => {
  const n = i32();
  const s = buf.toString("utf8", p, p + n);
  p += n + ((4 - (n % 4)) % 4);
  return s;
};

const TYPES = { 1: "byte", 2: "char", 3: "short", 4: "int", 5: "float", 6: "double" };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

console.log(`magic   ${buf.toString("latin1", 0, 3)}  version ${buf[3]}`);
p = 4;
const numrecs = i32();
console.log(`numrecs ${numrecs === -1 ? "STREAMING" : numrecs}\n`);

// --- dimensions ---
const dimTag = i32();
const nDims = i32();
const dims = [];
console.log("dimensions:");
for (let i = 0; i < nDims; i++) {
  const name = str();
  const size = i32();
  dims.push({ name, size });
  console.log(`  ${name} = ${size}${size === 0 ? "   <-- UNLIMITED" : ""}`);
}
console.log(`  (tag ${dimTag.toString(16)}, ${nDims} dims)\n`);

/** Attribute values, needed for scale_factor / add_offset / _FillValue. */
function readAttrs(label) {
  const tag = i32();
  const n = tag === 0 ? (i32(), 0) : i32();
  const out = {};
  for (let i = 0; i < n; i++) {
    const name = str();
    const type = i32();
    const nvals = i32();
    let val;
    if (type === 2) {
      val = buf.toString("utf8", p, p + nvals);
      p += nvals + ((4 - (nvals % 4)) % 4);
    } else {
      const vals = [];
      for (let k = 0; k < nvals; k++) {
        if (type === 3) vals.push(buf.readInt16BE(p + k * 2));
        else if (type === 4) vals.push(buf.readInt32BE(p + k * 4));
        else if (type === 5) vals.push(buf.readFloatBE(p + k * 4));
        else if (type === 6) vals.push(buf.readDoubleBE(p + k * 8));
        else vals.push(buf[p + k]);
      }
      const bytes = nvals * TYPE_SIZE[type];
      p += bytes + ((4 - (bytes % 4)) % 4);
      val = vals.length === 1 ? vals[0] : vals;
    }
    out[name] = val;
  }
  if (label && n) console.log(`  ${label}: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}

console.log("global attributes:");
readAttrs("  global");

// --- variables ---
const varTag = i32();
const nVars = i32();
console.log(`\nvariables (tag ${varTag.toString(16)}, ${nVars}):`);
for (let i = 0; i < nVars; i++) {
  const name = str();
  const nd = i32();
  const dimids = [];
  for (let k = 0; k < nd; k++) dimids.push(i32());
  const attrs = readAttrs(null);
  const type = i32();
  const vsize = i32();
  const begin = i32(); // version 1 = 32-bit offset
  const shape = dimids.map((d) => dims[d].name + "=" + dims[d].size).join(", ");
  console.log(`\n  ${name}  type=${TYPES[type]}  vsize=${vsize}  begin=${begin}`);
  console.log(`    dims: ${shape}`);
  const interesting = ["scale_factor", "add_offset", "_FillValue", "missing_value", "units"];
  for (const k of interesting) {
    if (attrs[k] !== undefined) console.log(`    ${k} = ${JSON.stringify(attrs[k])}`);
  }
  const isRecord = dimids.length && dims[dimids[0]].size === 0;
  if (isRecord) console.log(`    *** RECORD VARIABLE (uses the unlimited dimension)`);
}
