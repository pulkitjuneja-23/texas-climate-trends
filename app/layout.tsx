import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import SiteAnalytics from "@/components/SiteAnalytics";

const DESCRIPTION =
  "30 years of weather history and water use for any point in Texas — normals, individual years, forecast, and analog-year matching. Built for growers.";

export const metadata: Metadata = {
  /*
    Link previews (LinkedIn, Facebook, X, iMessage) read these tags. Without
    them a scraper guesses, and the first large image in the page is a team
    photo in the footer, so a shared link showed a person instead of the site.
    The image itself is app/opengraph-image.png, which Next.js links on its own;
    metadataBase makes its address absolute, which scrapers require.
  */
  metadataBase: new URL("https://www.farmwth.com"),
  openGraph: {
    title: "Texas Weather Explorer",
    description: DESCRIPTION,
    url: "/",
    siteName: "Texas Weather Explorer",
    type: "website",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: "Texas Weather Explorer", description: DESCRIPTION },
  /*
    The name says what the thing is, so it needs no expansion after it. The
    acronym it replaced had to be glossed everywhere it appeared — in the tab,
    in the masthead, in every exported file — which is a fair sign it was never
    doing the work a name is for.
  */
  title: "Texas Weather Explorer",
  description: DESCRIPTION,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}
