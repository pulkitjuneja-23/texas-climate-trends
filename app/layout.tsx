import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import SiteAnalytics from "@/components/SiteAnalytics";

export const metadata: Metadata = {
  /*
    The acronym leads because that is what the site will be called in
    conversation, and the expansion follows so a first-time visitor arriving
    from a search result knows what it is.
  */
  title: "TWIRE — Texas Weather and Irrigation Resource Explorer",
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
