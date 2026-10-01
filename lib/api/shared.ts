/**
 * Let simultaneous identical requests share one piece of upstream work.
 *
 * Vercel's CDN absorbs repeat visitors once an answer is cached, but not in the
 * moment a cached answer expires or a place first gets popular: everyone who
 * arrives then reaches the function, and each used to start the same upstream
 * fetch (R2, Earth Engine, NWS, Open-Meteo) separately. Under a crowd that is
 * exactly when the upstreams are slowest and most likely to refuse. With this,
 * the first caller does the work and the rest wait for its answer.
 *
 * Per server instance and only while the work is running; nothing is kept
 * afterwards. A failure is shared too, which is right: retrying the same call
 * at the same instant would only add load to whatever is already failing.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function shared<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Build ONE response for identical simultaneous requests, and hand each caller
 * its own copy.
 *
 * Sharing the upstream fetch was not enough. A burst test of 300 simultaneous
 * visitors at one place (worst case: no CDN in front) had every request still
 * reading 31 years from the cache and building its own ~1 MB answer; the middle
 * history request waited 44 s. Identical requests (same path and query, in any
 * parameter order) now wait for the first one's finished answer.
 *
 * Anything that must be counted per caller — the rate limit — has to run
 * BEFORE this, or a whole group would be counted once.
 */
export async function collapsed(
  req: Request,
  handler: (req: Request) => Promise<Response>
): Promise<Response> {
  const url = new URL(req.url);
  url.searchParams.sort();
  const out = await shared(`resp:${url.pathname}?${url.searchParams}`, async () => {
    const res = await handler(req);
    return {
      status: res.status,
      headers: [...res.headers.entries()],
      body: new Uint8Array(await res.arrayBuffer()),
    };
  });
  return new Response(out.body, { status: out.status, headers: out.headers });
}
