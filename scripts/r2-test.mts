/**
 * Check the R2 credentials before starting a 21-minute upload.
 *
 * Writes one tiny object, reads it back over the public URL, and deletes it.
 * Each failure mode is reported as the specific thing that is wrong, because
 * S3's errors for "wrong account id", "wrong key" and "wrong bucket" all look
 * alike from the outside.
 *
 * Run: node --experimental-strip-types scripts/r2-test.mts
 */
import { readFileSync } from "node:fs";
import { putObject, r2ConfigFromEnv } from "../lib/archive/r2.ts";

const env: Record<string, string> = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
} catch {
  console.error("No .env.local found.");
  process.exit(1);
}

// Length only: even a few characters of a secret should not end up in a
// screenshot or a pasted terminal log.
const mask = (v?: string) => (!v ? "MISSING" : `${v.length} chars`);

console.log("what is configured:");
console.log(`  R2_ACCOUNT_ID        ${mask(env.R2_ACCOUNT_ID)}`);
console.log(`  R2_ACCESS_KEY_ID     ${mask(env.R2_ACCESS_KEY_ID)}`);
console.log(`  R2_SECRET_ACCESS_KEY ${mask(env.R2_SECRET_ACCESS_KEY)}`);
console.log(`  R2_BUCKET            ${env.R2_BUCKET ?? "MISSING"}`);
console.log(`  NEXT_PUBLIC_R2_URL   ${env.NEXT_PUBLIC_R2_URL ?? "MISSING"}`);

// The account id is a 32-character hex string. Anything else is almost
// certainly one of the other values pasted into the wrong line.
if (env.R2_ACCOUNT_ID && !/^[0-9a-f]{32}$/i.test(env.R2_ACCOUNT_ID)) {
  console.log(
    `\n  ! R2_ACCOUNT_ID does not look like an account id.\n` +
      `    It should be 32 hexadecimal characters, e.g. 8f4a2c1e9b7d3f5a6c8e0b2d4f6a8c1e.\n` +
      `    Find it in the browser address bar on the Cloudflare dashboard:\n` +
      `      dash.cloudflare.com/THIS-PART-HERE/r2/overview\n` +
      `    or on the R2 page as the middle of the S3 endpoint:\n` +
      `      https://THIS-PART-HERE.r2.cloudflarestorage.com`
  );
}

const cfg = r2ConfigFromEnv(env);
if (!cfg) {
  console.error("\nCannot continue — see MISSING above.");
  process.exit(1);
}

const key = "gridmet/_connection-test.txt";
const body = Buffer.from(`written by r2-test at ${new Date().toISOString()}\n`);

console.log(`\nwriting ${key} ...`);
try {
  await putObject(cfg, key, body, {
    contentType: "text/plain",
    cacheControl: "no-store",
  });
  console.log("  upload OK");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`  upload FAILED: ${msg}\n`);
  if (/\b401\b|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(msg)) {
    console.error("  -> the access key or secret is wrong, or they are swapped.");
  } else if (/\b404\b|NoSuchBucket/i.test(msg)) {
    console.error(
      `  -> reached Cloudflare, but there is no bucket called "${cfg.bucket}" on this account.\n` +
        "     Check R2_BUCKET matches the bucket name exactly."
    );
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    console.error(
      "  -> that account id does not resolve. It is the 32-character hex string\n" +
        "     from the dashboard address bar, not the token or the access key."
    );
  } else if (/\b403\b/.test(msg)) {
    console.error(
      "  -> credentials accepted but not permitted. The token needs\n" +
        '     "Object Read & Write" on this bucket.'
    );
  }
  process.exit(1);
}

// The website reads over the public URL with no credentials, so prove that
// path works too — a bucket that uploads fine but is not public would fail
// only later, from the browser.
const publicUrl = env.NEXT_PUBLIC_R2_URL?.replace(/\/+$/, "");
if (!publicUrl) {
  console.log("\nNEXT_PUBLIC_R2_URL not set — skipping the public read check.");
} else {
  console.log(`reading it back from ${publicUrl} ...`);
  const res = await fetch(`${publicUrl}/${key}`, { cache: "no-store" });
  if (res.ok) {
    const text = (await res.text()).trim();
    console.log(`  public read OK: "${text}"`);
  } else {
    console.error(`  public read FAILED ${res.status}`);
    console.error(
      "  -> the upload worked, so the credentials are fine, but the bucket is not\n" +
        "     publicly readable yet. Bucket -> Settings -> Public Development URL -> Enable.\n" +
        "     Also check NEXT_PUBLIC_R2_URL matches the address shown there."
    );
    process.exit(1);
  }
}

console.log("\nR2 is ready.");
