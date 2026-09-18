/**
 * The two beacons the dashboard fires, and the rules about when.
 *
 * Both are fire-and-forget from an already-rendered page. Neither is awaited,
 * neither surfaces an error, and both use `keepalive` so a beacon sent as
 * someone navigates away still arrives. Telemetry is a curiosity about traffic;
 * it is not allowed to cost a grower their rainfall.
 */

import { isRealVisit, isSelf } from "./self";
import {
  visitorId,
  sessionId,
  screenClass,
  referrerHost,
  localClock,
  type PickMethod,
} from "./visitor";

/**
 * Feature events already sent this session, so each is recorded once.
 *
 * WHY DEDUPE, AND WHY PER SESSION. Without it, a grower toggling between
 * rainfall and temperature six times writes six rows and reads as six times the
 * interest of someone who looked once — the measure would reward fidgeting. The
 * question worth answering is "in what fraction of sittings did anyone open the
 * forecast", so one row per session per thing is exactly the right grain, and
 * it keeps the table small enough to fold in memory for years.
 */
const SENT_KEY = "twire:sent";

function alreadySent(tag: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(SENT_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (set.has(tag)) return true;
    set.add(tag);
    // Bounded so a very long session cannot grow this without limit.
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify([...set].slice(-400)));
    return false;
  } catch {
    // No session storage: send it. An over-count is better than a blind spot,
    // and this only happens in privacy modes.
    return false;
  }
}

function post(path: string, body: unknown): void {
  try {
    void fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      /* never visible */
    });
  } catch {
    /* never visible */
  }
}

/** Context every beacon carries. */
function envelope() {
  const clock = localClock();
  return {
    visitor: visitorId(),
    session: sessionId(),
    self: isSelf(),
    screen: screenClass(),
    hour: clock.hour,
    weekday: clock.weekday,
  };
}

/**
 * One location was looked at.
 *
 * Fires when the pin MOVES, not on every page view — flipping source, variable
 * or panel at one spot is one lookup, because it is one lookup.
 *
 * The coordinates are sent so the server can resolve a county; the server then
 * discards them. Nothing finer than a county is ever written down. See
 * lib/analytics/visits.ts.
 */
export function sendVisit(args: {
  lat: number;
  lon: number;
  source: string;
  via: PickMethod;
}): void {
  if (!isRealVisit()) return;
  post("/api/visit", {
    ...envelope(),
    lat: args.lat,
    lon: args.lon,
    source: args.source,
    via: args.via,
    referrer: referrerHost(),
  });
}

/**
 * Something was used — a panel opened, a variable chosen, a figure downloaded.
 *
 * `kind` is the category and `label` the value within it; both are short fixed
 * ids chosen in code, never anything a visitor typed. At most one row per
 * session per pair.
 */
export function trackOnce(kind: string, label: string): void {
  if (!isRealVisit()) return;
  const tag = `${kind}:${label}`;
  if (alreadySent(tag)) return;
  post("/api/event", { ...envelope(), kind, label });
}
