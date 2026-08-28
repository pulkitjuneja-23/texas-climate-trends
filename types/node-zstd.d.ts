/**
 * zstd support in `node:zlib`, which @types/node@20 does not yet describe.
 *
 * Node gained `zstdCompressSync` / `zstdDecompressSync` in v23; this project
 * runs v24 and both were verified working (including a round trip) before being
 * relied on. Only the type definitions are behind, so they are declared here
 * rather than upgrading @types/node — same approach as types/earthengine.d.ts.
 *
 * Delete this file once @types/node is upgraded past v23.
 *
 * The compression level is passed as
 *   { params: { [zlib.constants.ZSTD_c_compressionLevel]: 10 } }
 * where that constant is 100 — NOT one of the small numbers the zlib options
 * use.
 */
declare module "node:zlib" {
  interface ZstdOptions {
    params?: Record<number, number>;
    chunkSize?: number;
    maxOutputLength?: number;
  }

  function zstdCompressSync(
    buf: ArrayBufferView | ArrayBuffer | string,
    options?: ZstdOptions
  ): Buffer;

  function zstdDecompressSync(
    buf: ArrayBufferView | ArrayBuffer | string,
    options?: ZstdOptions
  ): Buffer;

  namespace constants {
    const ZSTD_c_compressionLevel: number;
  }
}
