/**
 * Minimal signed uploads to Cloudflare R2.
 *
 * R2 speaks the S3 API, which means requests must carry an AWS Signature
 * Version 4 header. That signature is a defined sequence of HMAC-SHA256 steps
 * and Node has HMAC-SHA256 built in, so this needs no SDK — which keeps the
 * ingest dependency-free and avoids pulling a large AWS client into a project
 * that makes exactly one kind of request.
 *
 * ONLY THE INGEST USES THIS. The website reads the archive over plain public
 * HTTPS with no credentials at all, because gridMET is freely redistributable
 * and the bucket is public-read. Nothing secret ships to the browser or to
 * Vercel.
 */

import { createHash, createHmac } from "node:crypto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(env: Record<string, string | undefined>): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** R2 has no regions in the AWS sense; the signature still requires a name. */
const REGION = "auto";
const SERVICE = "s3";

/**
 * Each path segment is escaped individually — a `/` separating segments must
 * stay literal, but any other reserved character inside a segment must not.
 * Getting this wrong produces a signature mismatch rather than a clear error.
 */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");
}

export interface PutOptions {
  contentType?: string;
  /** Sent as Cache-Control on the object, so the CDN can serve it. */
  cacheControl?: string;
}

/**
 * Sign and send one request. Shared by PUT and GET so there is exactly one
 * implementation of the signing sequence — two would drift, and a signature bug
 * surfaces as an opaque 403 rather than as anything that names the cause.
 */
async function signedRequest(
  cfg: R2Config,
  method: "PUT" | "GET",
  key: string,
  body: Buffer | null,
  opts: PutOptions = {}
): Promise<Response> {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? Buffer.alloc(0));

  // Header names must be lower-case and sorted; values trimmed.
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;
  if (opts.cacheControl) headers["cache-control"] = opts.cacheControl;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    body: body ? new Uint8Array(body) : undefined,
  });
}

/**
 * PUT one object. Returns nothing on success and throws with the server's own
 * message on failure — R2's XML errors are specific and worth surfacing.
 */
export async function putObject(
  cfg: R2Config,
  key: string,
  body: Buffer,
  opts: PutOptions = {}
): Promise<void> {
  const res = await signedRequest(cfg, "PUT", key, body, opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `R2 PUT ${key} failed ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 300)}`
    );
  }
}

/**
 * GET one object, or null if it is not there.
 *
 * The ingest needs this to read back the manifest it wrote on a previous run.
 * A partial rebuild must not invent the date ranges of the parts it is not
 * touching — see the rollover discussion in `ingest-gridmet.mts`.
 *
 * A signed GET rather than the public URL, so a scheduled run needs only the
 * four R2 credentials it already has, and so it always sees the object itself
 * rather than a CDN copy that may still be within its cache lifetime.
 */
export async function getObject(cfg: R2Config, key: string): Promise<Buffer | null> {
  const res = await signedRequest(cfg, "GET", key, null);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `R2 GET ${key} failed ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 300)}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload many objects with bounded concurrency.
 *
 * The ingest writes tens of thousands of small chunks, and firing them all at
 * once exhausts sockets long before it saturates the link. Failures are
 * retried, because one dropped chunk in an archive is a permanent hole that
 * nothing downstream would report.
 */
export async function putMany(
  cfg: R2Config,
  items: Array<{ key: string; body: Buffer; opts?: PutOptions }>,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
  const concurrency = opts.concurrency ?? 24;
  let next = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];

      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await putObject(cfg, item.key, item.body, item.opts);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;

      done++;
      if (opts.onProgress && done % 250 === 0) opts.onProgress(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  opts.onProgress?.(done, items.length);
}
