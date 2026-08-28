/**
 * Confirm the packing of every variable we intend to ingest.
 *
 * CLAUDE.md records a hard-won trap from the OPeNDAP `.ascii` endpoint: the
 * values are raw packed integers and the offset DIFFERS PER VARIABLE
 * (tmmx +220 K, tmmn +210 K, pr +0). Applying one offset to both temperatures
 * produced a daily minimum above the daily maximum.
 *
 * NCSS appears to declare scale_factor/add_offset properly in the header, which
 * would mean we can read them rather than hardcode them. That is worth
 * verifying for all four before building anything on it.
 */
const VARS = ["pr", "tmmx", "tmmn", "eto"];

function reader(buf) {
  let p = 0;
  const i32 = () => {
    const v = buf.readInt32BE(p);
    p += 4;
    return v;
  };
  const str = () => {
    const n = i32();
    const s = buf.toString("utf8", p, p + n);
    p += n + ((4 - (n % 4)) % 4);
    return s;
  };
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
  const TYPES = { 1: "byte", 2: "char", 3: "short", 4: "int", 5: "float", 6: "double" };

  p = 4;
  i32(); // numrecs
  i32(); // dim tag
  const nDims = i32();
  const dims = [];
  for (let i = 0; i < nDims; i++) dims.push({ name: str(), size: i32() });

  function attrs() {
    const tag = i32();
    const n = tag === 0 ? (i32(), 0) : i32();
    const out = {};
    for (let i = 0; i < n; i++) {
      const name = str();
      const type = i32();
      const nvals = i32();
      if (type === 2) {
        out[name] = buf.toString("utf8", p, p + nvals);
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
        out[name] = vals.length === 1 ? vals[0] : vals;
      }
    }
    return out;
  }

  attrs(); // global
  i32(); // var tag
  const nVars = i32();
  const vars = [];
  for (let i = 0; i < nVars; i++) {
    const name = str();
    const nd = i32();
    const dimids = [];
    for (let k = 0; k < nd; k++) dimids.push(i32());
    const a = attrs();
    const type = i32();
    const vsize = i32();
    const begin = i32();
    vars.push({
      name,
      type: TYPES[type],
      dims: dimids.map((d) => dims[d].name),
      shape: dimids.map((d) => dims[d].size),
      begin,
      vsize,
      attrs: a,
    });
  }
  return { dims, vars };
}

for (const v of VARS) {
  const url =
    `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${v}_1979_CurrentYear_CONUS.nc` +
    `?north=32.0&south=31.9&west=-97.5&east=-97.4` +
    `&time_start=2024-07-01T00:00:00Z&time_end=2024-07-02T00:00:00Z&accept=netcdf`;

  // Ask for every variable in the file so we learn its real name.
  const res = await fetch(url + "&var=" + (await variableName(v)));
  if (!res.ok) {
    console.log(`${v.padEnd(6)} FAILED ${res.status}`);
    continue;
  }
  const { vars } = reader(Buffer.from(await res.arrayBuffer()));
  const data = vars.find((x) => x.dims.length === 3);
  const a = data.attrs;
  console.log(
    `${v.padEnd(6)} ${data.name.padEnd(30)} ${String(data.type).padEnd(6)} ` +
      `scale=${a.scale_factor}  offset=${a.add_offset}  fill=${a._FillValue}  units=${a.units}`
  );

  // Decode one real value and check it is physically sensible.
  const buf = Buffer.from(
    await (await fetch(url + "&var=" + data.name)).arrayBuffer()
  );
  const raw = buf.readInt16BE(data.begin);
  const val = raw * (a.scale_factor ?? 1) + (a.add_offset ?? 0);
  console.log(
    `       first value: raw=${raw} -> ${val.toFixed(2)} ${a.units}` +
      (String(a.units).includes("K") ? `  = ${(val - 273.15).toFixed(2)} degC` : "")
  );
}

/** THREDDS names the grid variable differently per file; ask the catalog. */
async function variableName(v) {
  const xml = await (
    await fetch(
      `https://thredds.northwestknowledge.net/thredds/ncss/agg_met_${v}_1979_CurrentYear_CONUS.nc/dataset.xml`
    )
  ).text();
  const m = xml.match(/<grid name="([^"]+)"/);
  return m ? m[1] : v;
}
