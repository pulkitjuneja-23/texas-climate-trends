import { logEvent } from "@/lib/analytics/visits";
import { envelopeFrom, beaconOk } from "../_beacon";

/**
 * POST /api/event — record that a feature was used.
 *
 * Separate from /api/visit because the two answer different questions and have
 * different shapes: a visit is WHERE, an event is WHAT. Keeping them apart
 * means the map and the county table never have to filter out rows that carry
 * no county, and neither table grows columns that are null for most of it.
 *
 * The client sends at most one of each kind+label per session, so these count
 * SITTINGS in which something was used, not clicks. That is deliberate — see
 * lib/analytics/client.ts. This route does not re-check it: a duplicate is
 * harmless, and dropping a genuine event to guard against one would not be.
 *
 * `kind` and `label` are short fixed ids chosen in the app's own code. Nothing
 * a visitor typed is ever recorded here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    await logEvent({
      ...envelopeFrom(body),
      kind: typeof body.kind === "string" ? body.kind : "",
      label: typeof body.label === "string" ? body.label : "",
    });
  } catch {
    /* a bad body or a database that is down is not the visitor's problem */
  }
  return beaconOk();
}
