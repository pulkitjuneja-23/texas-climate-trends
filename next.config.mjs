/**
 * The address this project was first published at.
 *
 * Matched EXACTLY, and that is the whole safety of the rule below. Vercel also
 * issues preview addresses like
 * `texas-climate-trends-<hash>-pulkitjuneja-23.vercel.app`, and a pattern loose
 * enough to catch those would bounce every preview build to production — which
 * would make previews untestable while looking like they worked.
 */
const ORIGINAL_HOST = "texas-climate-trends.vercel.app";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Send the old address to the new one, keeping the old one alive.
   *
   * The original link has been shared with growers and sits in people's
   * bookmarks, so it must never break. A redirect keeps every one of those
   * links working while putting the real name in the address bar.
   *
   * `/:path*` carries the path AND the query string across, which matters more
   * than it looks: the private insights page is reached by a link with a key in
   * the query, and a redirect that dropped it would 404 with no clue why.
   *
   * TEMPORARY (307), NOT PERMANENT (308) — deliberately, for now. A browser
   * caches a permanent redirect more or less forever, so if farmwth.com ever
   * lapsed or broke, everyone who had followed it once would find the OLD link
   * broken too, and the fallback would be gone exactly when it was needed. The
   * domain is six days old and has already had two separate outages of its own
   * (a campus firewall block, and the apex confusion). Once it has run quietly
   * for a few months, change `permanent` to true so search engines transfer
   * properly.
   */
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: ORIGINAL_HOST }],
        destination: "https://farmwth.com/:path*",
        permanent: false,
      },
    ];
  },

  /**
   * Browser security headers, on every page and API response.
   *
   * - frame-ancestors 'none' / X-Frame-Options DENY: no other site may show this
   *   one inside a frame, so it cannot be dressed up as part of someone else's
   *   page.
   * - Referrer-Policy: when a visitor follows a link off the site, the other
   *   site learns only "farmwth.com", never the full address with its lat/lon.
   *   The insights page sends no referrer at all, because its address holds the
   *   key.
   * - nosniff: the browser treats each response as the type it is labelled.
   *
   * When two rules set the same header, the later one wins, so /insights comes
   * after the general rule.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/insights",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
