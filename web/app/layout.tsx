import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "GYT · Verified yachts, tracked and proven",
  description: "Verified yacht passports, live tracking with cryptographic proof, berth booking and Use or Earn ownership.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@100..900&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <SiteHeader />
        {children}
        <footer className="site-footer">
          <div className="wrap">
            <div>
              <b className="brandmark">GYT</b>
              <p className="small muted">Global Yacht Tokenization. Every record is hashed and anchored on-chain so anyone can check it.</p>
            </div>
            <p className="small muted">
              GYT links to official flag registration; it does not replace it. Economic units are offered only through licensed
              partners to eligible investors. Not legal, investment or maritime-registration advice.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
