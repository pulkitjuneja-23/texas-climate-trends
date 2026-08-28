/**
 * A minimal NetCDF-3 "classic" reader — enough for what THREDDS NCSS returns.
 *
 * WHY HAND-WRITTEN
 * The alternative was a dependency, and the ingest writer and the website
 * reader need to agree exactly on how a chunk is laid out. Splitting them
 * across two libraries (or two languages) makes a mismatch between them a
 * silent wrong-data bug, which is the failure this project can least afford.
 * The format is small, documented, and verified against real responses.
 *
 * WHAT WAS VERIFIED AGAINST THE LIVE SERVER (2026-08-27)
 *   - `accept=netcdf4` is BROKEN on northwestknowledge.net ("NetCDF: HDF
 *     error"). Only `accept=netcdf`, i.e. classic, works.
 *   - Version 1 (32-bit offsets), numrecs = 0.
 *   - `day` is a FIXED dimension, not the unlimited one, so the data variable
 *     is one contiguous block in (day, lat, lon) order. This matters enormously:
 *     an unlimited dimension would interleave the data by record and a reader
 *     assuming contiguity would return silently scrambled values.
 *   - Data variables are `short` (int16) with per-variable scale_factor and
 *     add_offset declared in the header.
 *
 * EVERYTHING IS BIG-ENDIAN. Node reads little-endian natively, so bulk arrays
 * are byte-swapped rather than read element by element.
 */

export type NcValue = string | number | number[];

export interface NcVariable {
  name: string;
  /** NetCDF type code: 1 byte, 2 char, 3 short, 4 int, 5 float, 6 double. */
  type: number;
  dims: string[];
  shape: number[];
  /** Byte offset of this variable's data within the file. */
  begin: number;
  vsize: number;
  attrs: Record<string, NcValue>;
}

export interface NcFile {
  dims: Map<string, number>;
  vars: Map<string, NcVariable>;
  attrs: Record<string, NcValue>;
  buf: Buffer;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

/** Strings and attribute blocks are padded to a 4-byte boundary. */
const pad4 = (n: number) => (4 - (n % 4)) % 4;

export function parseNetCDF3(buf: Buffer): NcFile {
  if (buf.length < 8 || buf.toString("latin1", 0, 3) !== "CDF") {
    // A THREDDS error is returned as XML or HTML with a 200 in some cases, so
    // say what actually arrived rather than "invalid file".
    const head = buf.toString("utf8", 0, 200).replace(/\s+/g, " ").trim();
    throw new Error(`Not a NetCDF-3 file. First bytes: ${head.slice(0, 160)}`);
  }

  const version = buf[3];
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported NetCDF version ${version}`);
  }
  /** Version 2 ("64-bit offset") stores `begin` as int64 instead of int32. */
  const offsetIs64 = version === 2;

  let p = 4;
  const i32 = () => {
    const v = buf.readInt32BE(p);
    p += 4;
    return v;
  };
  const offset = () => {
    if (!offsetIs64) return i32();
    const v = buf.readBigInt64BE(p);
    p += 8;
    return Number(v);
  };
  const str = () => {
    const n = i32();
    const s = buf.toString("utf8", p, p + n);
    p += n + pad4(n);
    return s;
  };

  i32(); // numrecs — unused, we reject record variables below

  function readList(expectedTag: number): number {
    const tag = i32();
    const n = i32();
    // ABSENT is encoded as two zero words.
    if (tag === 0) return 0;
    if (tag !== expectedTag) {
      throw new Error(`Expected list tag 0x${expectedTag.toString(16)}, got 0x${tag.toString(16)}`);
    }
    return n;
  }

  function readAttrs(): Record<string, NcValue> {
    const n = readList(0x0c);
    const out: Record<string, NcValue> = {};
    for (let i = 0; i < n; i++) {
      const name = str();
      const type = i32();
      const nvals = i32();
      if (type === 2) {
        out[name] = buf.toString("utf8", p, p + nvals);
        p += nvals + pad4(nvals);
      } else {
        const vals: number[] = [];
        for (let k = 0; k < nvals; k++) {
          const at = p + k * TYPE_SIZE[type];
          if (type === 1) vals.push(buf.readInt8(at));
          else if (type === 3) vals.push(buf.readInt16BE(at));
          else if (type === 4) vals.push(buf.readInt32BE(at));
          else if (type === 5) vals.push(buf.readFloatBE(at));
          else if (type === 6) vals.push(buf.readDoubleBE(at));
        }
        const bytes = nvals * TYPE_SIZE[type];
        p += bytes + pad4(bytes);
        out[name] = vals.length === 1 ? vals[0] : vals;
      }
    }
    return out;
  }

  // --- dimensions ---
  const nDims = readList(0x0a);
  const dimNames: string[] = [];
  const dims = new Map<string, number>();
  for (let i = 0; i < nDims; i++) {
    const name = str();
    const size = i32();
    dimNames.push(name);
    dims.set(name, size);
  }

  const globalAttrs = readAttrs();

  // --- variables ---
  const nVars = readList(0x0b);
  const vars = new Map<string, NcVariable>();
  for (let i = 0; i < nVars; i++) {
    const name = str();
    const nd = i32();
    const dimIds: number[] = [];
    for (let k = 0; k < nd; k++) dimIds.push(i32());
    const attrs = readAttrs();
    const type = i32();
    const vsize = i32();
    const begin = offset();

    const vDims = dimIds.map((d) => dimNames[d]);
    const shape = vDims.map((d) => dims.get(d) as number);

    if (shape.some((s) => s === 0)) {
      // A zero-length dimension is the unlimited one; such variables are stored
      // interleaved by record, not contiguously. We have never seen NCSS return
      // one, and reading it as contiguous would scramble the data silently — so
      // refuse rather than guess.
      throw new Error(
        `Variable "${name}" uses the unlimited dimension; this reader only handles fixed dimensions.`
      );
    }

    vars.set(name, { name, type, dims: vDims, shape, begin, vsize, attrs });
  }

  return { dims, vars, attrs: globalAttrs, buf };
}

function variable(f: NcFile, name: string): NcVariable {
  const v = f.vars.get(name);
  if (!v) {
    throw new Error(`No variable "${name}". Have: ${[...f.vars.keys()].join(", ")}`);
  }
  return v;
}

/** Total element count for a variable. */
export function count(v: NcVariable): number {
  return v.shape.reduce((a, b) => a * b, 1);
}

/**
 * Raw int16 values, exactly as stored — scale_factor and add_offset are NOT
 * applied.
 *
 * That is deliberate: the archive stores the same packed integers with the same
 * attributes, so the numbers pass through untouched. Unpacking here and
 * repacking later would be two lossy float round-trips for no reason.
 */
export function readShorts(f: NcFile, name: string): Int16Array {
  const v = variable(f, name);
  if (v.type !== 3) throw new Error(`Variable "${name}" is type ${v.type}, expected short (3)`);
  const n = count(v);
  const end = v.begin + n * 2;
  if (end > f.buf.length) {
    throw new Error(`Variable "${name}" runs past the end of the file (${end} > ${f.buf.length})`);
  }
  // Copy before swapping — swap16 mutates, and the source buffer may hold other
  // variables we still need to read.
  const bytes = Buffer.from(f.buf.subarray(v.begin, end));
  bytes.swap16();
  return new Int16Array(bytes.buffer, bytes.byteOffset, n);
}

/** Coordinate axes (day, lat, lon) are doubles. */
export function readDoubles(f: NcFile, name: string): Float64Array {
  const v = variable(f, name);
  if (v.type !== 6) throw new Error(`Variable "${name}" is type ${v.type}, expected double (6)`);
  const n = count(v);
  const bytes = Buffer.from(f.buf.subarray(v.begin, v.begin + n * 8));
  bytes.swap64();
  return new Float64Array(bytes.buffer, bytes.byteOffset, n);
}

/** The single 3-D data variable in an NCSS response, whatever it is called. */
export function dataVariable(f: NcFile): NcVariable {
  for (const v of f.vars.values()) if (v.dims.length === 3) return v;
  throw new Error(`No 3-D data variable. Have: ${[...f.vars.keys()].join(", ")}`);
}
