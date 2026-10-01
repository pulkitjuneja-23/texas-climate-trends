"use client";

import { Analytics } from "@vercel/analytics/next";
import { isSelf } from "@/lib/analytics/self";

/**
 * Vercel Web Analytics, with the author's own visits filtered out.
 *
 * A separate client component because `beforeSend` is a function and
 * `app/layout.tsx` is a server component — functions cannot cross that
 * boundary. This file exists only to hold the callback.
 *
 * WHAT THIS GIVES AND WHAT IT DOES NOT. Page views, visitor counts, referrers,
 * devices, and the visitor's own country and city. It does NOT record which
 * field a grower looked up: that would need a custom event, which Vercel does
 * not offer on the Hobby plan. That question is answered by our own visit log
 * instead — see app/api/visit/route.ts — which also keeps the answer for longer
 * than Vercel's one-month window and keeps it out of a third party.
 *
 * "Visitors" here means unique PER DAY, not per person: Vercel identifies a
 * visitor by a hash of the request and discards it after 24 hours, which is how
 * it avoids cookies. One grower checking the site on five days counts as five.
 * Read it as a traffic signal, not a headcount.
 */
export default function SiteAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        // Returning null drops the event entirely — nothing is sent.
        if (isSelf()) return null;
        try {
          const url = new URL(event.url);
          // The private insights page is opened with its key in the address.
          // Its views are not traffic worth counting, and the key must never
          // leave for a third party, so nothing about it is sent.
          if (url.pathname.startsWith("/insights")) return null;
          // The query string carries a shared link's lat/lon — someone's field.
          // Our own visit log keeps only the county; Vercel gets only the path.
          url.search = "";
          return { ...event, url: url.toString() };
        } catch {
          return null;
        }
      }}
    />
  );
}
