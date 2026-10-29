import Link from "next/link";
import { api, type Yacht } from "@/lib/api";
import HashCheck from "@/components/HashCheck";
import HeroVideo from "@/components/HeroVideo";
import HashTicker from "@/components/HashTicker";
import LiveMap from "@/components/LiveMap";
import YachtCard from "@/components/YachtCard";
import { CountUp, KineticHeadline } from "@/components/Kinetic";
import { getSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

const STEPS = [
  ["Verify", "Each yacht's registry entry, documents, insurance and surveys are checked and hashed into a digital passport."],
  ["Track", "Signed onboard GPS, AIS and satellite radar are compared. A position counts only when independent signals agree."],
  ["Prove", "Every event becomes a hash. Batches are anchored on a blockchain, so anyone can check a record was never altered."],
  ["Settle", "Berth and charter payments wait in escrow and release only when the yacht's arrival is proven."],
];

type Recent = { leaf: string; event_type: string; yacht_id: string; anchor_id: number };

export default async function Home({ searchParams }: { searchParams: { denied?: string } }) {
  const [yachts, marinas, recent, user] = await Promise.all([
    api<Yacht[]>("/yachts").catch(() => [] as Yacht[]),
    api<{ id: string }[]>("/marinas").catch(() => []),
    api<Recent[]>("/proofs/recent?limit=14").catch(() => [] as Recent[]),
    getSession(),
  ]);
  const featured = yachts.filter((y) => y.insurance_verified).slice(0, 3);
  const units = yachts.filter((y) => y.tokenized).length;
  return (
    <main className="home">
      {searchParams.denied && (
        <div className="wrap"><p className="banner warn">That area is for administrators. Sign in with an admin account to open it.</p></div>
      )}
      <section className="hero hero-full">
        <HeroVideo />
        <div className="wrap hero-grid hero-inner">
          <div>
            <div className="eyebrow">Verified · Tracked · Proven</div>
            <KineticHeadline className="display" text="Know where a yacht is, and prove it." />
            <p className="lede">
              GYT gives every yacht a verified passport, follows it with three independent tracking signals, and records every
              event as a hash anyone can check.
            </p>
            <div className="row">
              <Link className="btn primary lg" href="/yachts">Explore yachts</Link>
              <Link className="btn lg" href={user ? "/track" : "/signup"}>{user ? "Track a yacht" : "Create a free account"}</Link>
            </div>
            <div className="stats">
              <div><b><CountUp value={yachts.length} /></b><span>verified yachts</span></div>
              <div><b><CountUp value={marinas.length} /></b><span>partner marinas</span></div>
              <div><b><CountUp value={units} /></b><span>offering units</span></div>
              <div><b>3</b><span>signals per position</span></div>
            </div>
          </div>
          <div className="panel verify-card glass">
            <div className="eyebrow">Try it</div>
            <h2>Verify any record</h2>
            <p className="small muted">Paste a hash from any yacht's timeline. Your browser does the maths; you don't have to trust us.</p>
            <HashCheck compact />
          </div>
        </div>
        <a className="hero-scroll" href="#live" aria-label="Scroll to the live map">↓</a>
      </section>

      <HashTicker initial={recent} />

      <section className="wrap band" id="live">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div className="eyebrow">Live now</div>
            <h2>Yachts on the water</h2>
            <p className="small muted">GYT yachts from signed GPS and AIS, plus pleasure craft heard on free public AIS. Click a yacht to follow it.</p>
          </div>
          <Link href="/track">Open full tracker →</Link>
        </div>
        <LiveMap height={520} />
      </section>

      <section className="wrap band">
        <div className="eyebrow">How it works</div>
        <h2>From paperwork to proof</h2>
        <ol className="steps4">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="reveal" style={{ ["--d" as string]: `${i * 90}ms` }}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span><b>{t}</b><p className="small muted">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="wrap band">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <div><div className="eyebrow">Featured</div><h2>Verified yachts</h2></div>
          <Link href="/yachts">See all {yachts.length} →</Link>
        </div>
        <div className="cards2">
          {featured.map((y) => <YachtCard key={y.id} y={y} />)}
        </div>
      </section>

      <section className="wrap band split">
        <div className="panel">
          <div className="eyebrow">For investors</div>
          <h2>Use it, or earn from it</h2>
          <p className="muted">Units in a yacht carry yearly usage credits. Spend them on nights aboard any verified yacht, or pool them and get paid when guests book.</p>
          <Link href="/earn">How Use or Earn works →</Link>
        </div>
        <div className="panel">
          <div className="eyebrow">For owners</div>
          <h2>List your yacht</h2>
          <p className="muted">Submit your vessel and documents. Files are hashed on your device; our team verifies and mints the passport.</p>
          <Link href="/onboard">Start onboarding →</Link>
        </div>
      </section>
    </main>
  );
}
