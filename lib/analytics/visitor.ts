/**
 * Who is this browser, and what kind of screen is it on?
 *
 * ---------------------------------------------------------------------------
 * WHAT THE VISITOR ID IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * A random code generated in the browser on first arrival and kept in that
 * browser's own storage. It is not derived from anything: no IP address, no
 * user agent, no screen fingerprint, no account, no email. It cannot be
 * reversed into a person, and nothing else we store could be joined to it to
 * identify one, because nothing else identifying is stored at all.
 *
 * It exists to answer one question the previous design could not: how many
 * DISTINCT people use this, and do they come back? Before this, two visits by
 * one grower and one visit each by two growers were literally the same rows.
 * For deciding where extension effort should go, that difference is the whole
 * point — a county with forty lookups from two people is a different situation
 * from forty lookups from thirty.
 *
 * THE HONEST COST, stated because it is a real one: this is persistent
 * identification of a browser, which the county-only design avoided entirely.
 * It was added on 18 September 2026 as an explicit decision, with a plain
 * sentence added to the site's footer saying it happens. That sentence is not
 * decoration — do not remove it while this file exists.
 *
 * ---------------------------------------------------------------------------
 * EVERY STORAGE ACCESS IS GUARDED
 * ---------------------------------------------------------------------------
 * localStorage throws outright in some privacy modes rather than returning
 * null. A browser that refuses to store anything still gets to use the site
 * normally; it simply arrives as an unknown visitor every time, which shows up
 * in the figures as a slight over-count of new people. That is the right
 * direction to fail: it never blocks anyone and never invents a returning
 * visitor who is not there.
 */

/**
 * One storage namespace for the whole site.
 *
 * `twire:` is the acronym the app used to be called. It stays for the same
 * reason `twire:self` stays — these are storage keys, not labels; nobody reads
 * them; and renaming one silently orphans whatever is already stored under the
 * old name. A second prefix would be worse than an out-of-date one.
 */
const VISITOR_KEY = "twire:visitor";
const SESSION_KEY = "twire:session";

/** Screen class, not device class — it is measured from the viewport. */
export type ScreenClass = "phone" | "tablet" | "desktop";

/** How the grower put the pin where it is. */
export type PickMethod = "map" | "search" | "coords" | "gps" | "link" | "default";

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Only reached on browsers without randomUUID. Collision risk across the
  // handful of visitors this will ever see is negligible.
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function readOrCreate(store: Storage | undefined, key: string): string | null {
  if (!store) return null;
  try {
    const existing = store.getItem(key);
    if (existing) return existing;
    const made = randomId();
    store.setItem(key, made);
    return made;
  } catch {
    return null;
  }
}

function safeStore(kind: "local" | "session"): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Stable across visits, for as long as the visitor keeps their browser data.
 *
 * Returns null when storage is unavailable rather than inventing a per-page
 * value — a fresh id on every page load would inflate the visitor count with
 * people who do not exist, which is worse than admitting we do not know.
 */
export function visitorId(): string | null {
  return readOrCreate(safeStore("local"), VISITOR_KEY);
}

/** Lives until the tab closes. Groups one sitting together. */
export function sessionId(): string | null {
  return readOrCreate(safeStore("session"), SESSION_KEY);
}

/**
 * Phone, tablet or desktop, from the viewport and the pointer.
 *
 * The 620 px boundary is the site's own mobile breakpoint, so this reports the
 * layout the visitor actually saw rather than a guess about their hardware. A
 * desktop window dragged narrow counts as a phone here, and that is correct for
 * the question being asked — which is whether the small-screen layout is what
 * people are reading, not what they bought.
 */
export function screenClass(): ScreenClass {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w <= 620) return "phone";
  const coarse =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  if (w <= 1024 && coarse) return "tablet";
  return "desktop";
}

/**
 * Where the visitor came from — the HOST only, never the full address.
 *
 * A referring URL can carry a search query or a private document's path in it.
 * The host answers what is actually being asked (did they come from an email, a
 * search engine, an extension newsletter) and carries none of that.
 */
export function referrerHost(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const ref = document.referrer;
    if (!ref) return null;
    const host = new URL(ref).hostname.replace(/^www\./, "");
    // Moving around inside the site is not a referral.
    if (host === window.location.hostname.replace(/^www\./, "")) return null;
    return host.slice(0, 64);
  } catch {
    return null;
  }
}

/**
 * The visitor's own clock.
 *
 * Sent rather than derived on the server, because the server sees UTC and
 * "growers check this over breakfast" is a statement about their morning, not
 * about Greenwich. Texas spans two time zones, so even assuming Central would
 * be wrong for El Paso.
 */
export function localClock(): { hour: number; weekday: number } {
  const d = new Date();
  return { hour: d.getHours(), weekday: d.getDay() };
}
