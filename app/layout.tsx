import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";

export const metadata: Metadata = {
  title: "Texas Climate Trends",
  description:
    "30 years of weather history for any point in Texas — normals, individual years, forecast, and analog-year matching. Built for growers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
