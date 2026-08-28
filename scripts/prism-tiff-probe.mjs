/**
 * How hard is PRISM's GeoTIFF to read?
 *
 * The ingest would need its own reader, and the cost of writing one depends
 * almost entirely on the compression: uncompressed or Deflate is
 * straightforward (Node has zlib), LZW or anything tiled and predicted is a
 * different size of job. Worth knowing before estimating the work.
 */
import { unzipSync } from "fflate";

const res = await fetch("https://services.nacse.org/prism/data/get/us/4km/ppt/20240701");
const files = unzipSync(new Uint8Array(Buffer.from(await res.arrayBuffer())));
const name = Object.keys(files).find((n) => n.endsWith(".tif"));
const tif = Buffer.from(files[name]);
console.log(`${name}  ${(tif.length / 1048576).toFixed(2)} MB\n`);

// TIFF header: byte order, magic 42, offset of the first image directory.
const le = tif.toString("latin1", 0, 2) === "II";
const u16 = (o) => (le ? tif.readUInt16LE(o) : tif.readUInt16BE(o));
const u32 = (o) => (le ? tif.readUInt32LE(o) : tif.readUInt32BE(o));
console.log(`byte order        ${le ? "little-endian" : "big-endian"}`);
console.log(`magic             ${u16(2)} (42 = classic TIFF, 43 = BigTIFF)`);

const TAGS = {
  256: "ImageWidth",
  257: "ImageLength",
  258: "BitsPerSample",
  259: "Compression",
  262: "PhotometricInterpretation",
  273: "StripOffsets",
  277: "SamplesPerPixel",
  278: "RowsPerStrip",
  279: "StripByteCounts",
  317: "Predictor",
  322: "TileWidth",
  323: "TileLength",
  324: "TileOffsets",
  339: "SampleFormat",
  42113: "GDAL_NODATA",
};
const COMPRESSION = {
  1: "none (raw)",
  5: "LZW",
  8: "Deflate",
  32773: "PackBits",
  50013: "Deflate (zlib)",
};
const SAMPLE_FORMAT = { 1: "uint", 2: "int", 3: "IEEE float" };

let off = u32(4);
const n = u16(off);
console.log(`directory entries ${n}\n`);

for (let i = 0; i < n; i++) {
  const e = off + 2 + i * 12;
  const tag = u16(e);
  const type = u16(e + 2);
  const count = u32(e + 4);
  // Values of 4 bytes or fewer are stored inline.
  const inline = count * (type === 3 ? 2 : type === 4 ? 4 : 1) <= 4;
  const value = inline ? (type === 3 ? u16(e + 8) : u32(e + 8)) : u32(e + 8);
  const label = TAGS[tag];
  if (!label) continue;

  let extra = "";
  if (label === "Compression") extra = `  <- ${COMPRESSION[value] ?? "unknown"}`;
  if (label === "SampleFormat") extra = `  <- ${SAMPLE_FORMAT[value] ?? "?"}`;
  if (label === "Predictor") extra = value === 1 ? "  <- none" : "  <- HORIZONTAL DIFFERENCING";
  console.log(
    `  ${label.padEnd(26)} ${inline ? value : `@${value} (${count} values)`}${extra}`
  );
}
