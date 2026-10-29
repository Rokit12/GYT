import Link from "next/link";
import { api, usd, type Yacht } from "@/lib/api";
import HashCheck from "@/components/HashCheck";
import { getSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

const STEPS = [
  ["Verify", "Each yacht's registry entry, documents, insurance and surveys are checked and hashed into a digital passport."],
  ["Track", "Signed onboard GPS, AIS and satellite radar are compared. A position counts only when independent signals agree."],
  ["Prove", "Every event becomes a hash. Batches are anchored on a blockchain, so anyone can check a record was never altered."],
  ["Settle", "Berth and charter payments wait in escrow and release only when the yacht's arrival is proven."],
];

export default async function Home({ searchParams }: { searchParams: { denied?: string } }) {
  const [yachts, marinas, user] = await Promise.all([
    api<Yacht[]>("/yachts").catch(() => [] as Yacht[]),
    api<{ id: string }[]>("/marinas").catch(() => []),
    getSession(),
  ]);
  const featured = yachts.filter((y) => y.insurance_verified).slice(0, 3);
  return (
    <main className="home">
      {searchParams.denied && (
        <div className="wrap"><p className="banner warn">That area is for administrators. Sign in with an admin account to open it.</p></div>
      )}
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <div className="eyebrow">Verified · Tracked · Proven</div>
            <h1 className="display">Know where a yacht is, and prove it.</h1>
            <p className="lede">
              GYT gives every yacht a verified passport, follows it with three independent tracking signals, and records every
              event as a hash anyone can check.
            </p>
            <div className="row">
              <Link className="btn primary lg" href="/yachts">Explore yachts</Link>
              <Link className="btn lg" href={user ? "/track" : "/signup"}>{user ? "Track a yacht" : "Create a free account"}</Link>
            </div>
            <div className="stats">
              <div><b>{yachts.length}</b><span>verified yachts</span></div>
              <div><b>{marinas.length}</b><span>partner marinas</span></div>
              <div><b>3</b><span>signals per position</span></div>
            </div>
          </div>
          <div className="panel verify-card">
            <div className="eyebrow">Try it</div>
            <h2>Verify any record</h2>
            <p className="small muted">Paste a hash from any yacht's timeline. Your browser does the maths; you don't have to trust us.</p>
            <HashCheck compact />
          </div>
        </div>
      </section>

      <section className="wrap band">
        <div className="eyebrow">How it works</div>
        <h2>From paperwork to proof</h2>
        <ol className="steps4">
          {STEPS.map(([t, d], i) => (
            <li key={t}><span className="num">{i + 1}</span><b>{t}</b><p className="small muted">{d}</p></li>
          ))}
        </ol>
      </section>

      <section className="wrap band">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <div><div className="eyebrow">Featured</div><h2>Verified yachts</h2></div>
          <Link href="/yachts">See all {yachts.length} →</Link>
        </div>
        <div className="fleet">
          {featured.map((y) => (
            <Link key={y.id} href={`/yachts/${y.id}`} className="yc">
              <span className="yc-hull" aria-hidden="true" />
              <span className="eyebrow">{y.id}</span>
              <b>{y.name}</b>
              <span className="small muted">{Number(y.loa_m)} m · {y.marina_name}</span>
              <span className="row small"><span className="pill ok">Verified</span>{y.charter_week_usd && <span>{usd(y.charter_week_usd)} / week</span>}</span>
            </Link>
          ))}
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
