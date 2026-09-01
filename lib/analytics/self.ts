/**
 * "Don't count me."
 *
 * The whole point of turning analytics on here is to find out whether anyone
 * ELSE is using the site. The author has clicked around it hundreds of times
 * across dozens of locations while it was being built, and will keep doing so —
 * so without this every chart would mostly be a picture of its own developer.
 *
 * HOW IT WORKS. Visit the site once with `?notme=1` and this browser is marked
 * as the author's, in localStorage, permanently. `?notme=0` undoes it. From
 * then on Vercel's page views are dropped before they are sent, and our own
 * visit log records the visit with a `self` flag so it can be excluded at query
 * time — kept rather than discarded, because being able to SEE your own visits
 * marked is how you confirm the exclusion is actually working.
 *
 * HONEST LIMIT: this is per browser and per device. A phone and a laptop each
 * need marking once, and clearing site data unmarks them. There is no better
 * option without asking visitors to log in, which for a public tool would be a
 * far worse trade than occasionally counting one's own phone.
 */

/*
  DELIBERATELY still the old name. This is a storage key, not a label — nobody
  reads it — and renaming it would silently un-mark every browser already
  flagged, so the author's own phone and laptop would start counting as real
  traffic with nothing on screen to say so. Renaming it costs a measurement and
  buys tidiness.
*/
const KEY = "twire:self";
const TURN_ON = /[?&]notme=1\b/;
const TURN_OFF = /[?&]notme=0\b/;

/**
 * Is this browser the author's?
 *
 * Reads the URL as well as the stored flag, and writes the flag when the URL
 * says so. Combining the two is deliberate: the very first event on the page
 * that sets the flag would otherwise be recorded before any effect had a chance
 * to run, which is exactly the visit someone is trying not to record.
 *
 * localStorage throws in some privacy modes, so every access is guarded. A
 * browser that will not store the flag simply gets counted, which is the right
 * way for this to fail.
 */
export function isSelf(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = window.location.search;
    if (TURN_OFF.test(q)) {
      window.localStorage.removeItem(KEY);
      return false;
    }
    if (TURN_ON.test(q)) {
      window.localStorage.setItem(KEY, "1");
      return true;
    }
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Development and preview builds are never counted.
 *
 * `@vercel/analytics` already ignores localhost on its own, but our visit log
 * is our own code and would happily record every page reload during a debugging
 * session. Preview deployments are excluded too: they exist to be clicked
 * through by the person who made them.
 */
export function isRealVisit(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")) return false;
  // Vercel preview URLs carry the git branch or a deployment hash; production
  // is the bare project domain.
  if (/-[a-z0-9]{9,}\.vercel\.app$/i.test(h)) return false;
  return true;
}
