import Link from "next/link";
import { LogoLockup } from "./Logo";

export default function SiteFooter() {
  return (
    <footer className="wrap foot2">
      <div className="foot2-grid">
        <div className="foot2-brand">
          <Link className="brand2" href="/" aria-label="GYT home"><LogoLockup /></Link>
          <p className="small muted">Verified passports, live tracking and records anyone can check, for every yacht on the platform.</p>
        </div>
        <nav aria-label="Platform"><b>Platform</b><Link href="/yachts">Explore yachts</Link><Link href="/how-it-works">How it works</Link><Link href="/map">Yacht map</Link><Link href="/track">Track &amp; verify</Link><Link href="/track/device">Track from your phone</Link><Link href="/verify">Verify a record</Link><Link href="/earn">Use or Earn</Link></nav>
        <nav aria-label="Company"><b>Company</b><Link href="/about">About GYT</Link><Link href="/onboard">List your yacht</Link><Link href="/how-it-works#faq">Questions</Link><Link href="/signup">Create an account</Link></nav>
        <nav aria-label="Open data"><b>Open data we use</b><span className="small muted">AIS: Digitraffic, aisstream.io</span><span className="small muted">Maps: OpenStreetMap, OpenFreeMap, Natural Earth</span><span className="small muted">Radar: Copernicus Sentinel-1</span></nav>
      </div>
      <p className="small muted foot2-legal">
        GYT links to official flag registration; it does not replace it. Economic units are offered only through licensed
        partners to eligible investors. Not legal, investment or maritime-registration advice.
      </p>
    </footer>
  );
}
