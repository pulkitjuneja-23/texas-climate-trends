import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import SiteAnalytics from "@/components/SiteAnalytics";

export const metadata: Metadata = {
  /*
    The name says what the thing is, so it needs no expansion after it. The
    acronym it replaced had to be glossed everywhere it appeared — in the tab,
    in the masthead, in every exported file — which is a fair sign it was never
    doing the work a name is for.
  */
  title: "Texas Weather Explorer",
  description:
    "30 years of weather history and water use for any point in Texas — normals, individual years, forecast, and analog-year matching. Built for growers.",
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
