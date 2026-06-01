import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_SITE_NAME ?? "Uptime & SLO Monitor",
  description:
    "Real-time and historical uptime, latency SLIs, error-budget burn, and multi-window multi-burn-rate alerts for a set of live endpoints.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
