import Link from "next/link";
import { api, type Yacht } from "@/lib/api";
import { CountUp, KineticHeadline } from "@/components/Kinetic";
import Parallax from "@/components/Parallax";

export const dynamic = "force-dynamic";
export const metadata = { title: "GYT · About" };

const PRINCIPLES = [
  ["Proof over promises", "If we say a yacht arrived, you can recompute the proof in your own browser."],
  ["Hashes, not your files", "Documents stay encrypted off-chain. Only their fingerprints are public."],
  ["Regulated where it matters", "Ownership units go only through licensed partners, to eligible investors, with checks on every transfer."],
  ["Open data first", "We build on public AIS, open coastlines and satellite data, and say where every signal comes from."],
];
const SOURCES = [
  ["Signed onboard GPS", "Tamper-evident trackers that sign each fix with a device key."],
  ["Public AIS", "Digitraffic (Fintraffic, open data) and aisstream.io, streamed live to the map."],
  ["Satellite radar", "Copernicus Sentinel-1 detections, used to confirm hulls when AIS goes quiet."],
  ["OSIRIS", "Maritime surveillance research from CNR-ISTI, through a research partnership."],
  ["Public blockchain", "Merkle roots of every batch anchored to a public chain for permanent proof."],
  ["Open maps", "Natural Earth coastlines and OpenStreetMap-based tiles from OpenFreeMap."],
];
const ROADMAP = [
  ["Now", "Pilot fleet and partner marinas", "Verified passports, three-signal tracking and escrowed berth bookings with a first group of marinas."],
  ["Next", "Use or Earn for unit holders", "Yearly credits for nights aboard, or pooled earnings, through licensed partners."],
  ["Later", "Insurers, surveyors and registries", "Let the people who certify yachts write their findings straight into the passport."],
];

export default async function About() {
  const [yachts, marinas, recent] = await Promise.all([
    api<Yacht[]>("/yachts").catch(() => [] as Yacht[]),
    api<{ id: string }[]>("/marinas").catch(() => []),
    api<{ anchor_id: number }[]>("/proofs/recent?limit=50").catch(() => []),
  ]);
  return (
    <main className="wrap page">
      <div className="abouthero">
        <Parallax src="/media/yachts/YACHT-000004.jpg" className="ah-img" />
        <div className="ah-shade" aria-hidden="true" />
        <div className="ah-in">
          <div className="eyebrow">About GYT</div>
          <KineticHeadline className="display" text="Yacht records you can check, not just trust." />
          <p className="lede">Global Yacht Tokenization gives every yacht a verified digital passport, follows it with independent tracking signals, and seals each record with a hash anyone can verify.</p>
        </div>
      </div>

      <div className="about2">
        <div><div className="eyebrow">Why we exist</div><h2>Yacht information is scattered and hard to prove</h2>
          <p>Registration, surveys, insurance, maintenance and position data live in different places: PDFs, inboxes, registries and transponder feeds that do not talk to each other. Buyers, guests, marinas and investors end up taking someone&apos;s word for it.</p></div>
        <div><div className="eyebrow">What we do</div><h2>One passport, three signals, open proof</h2>
          <p>We check a yacht&apos;s documents once and hash them into a passport. We follow it with signed onboard GPS, public AIS and satellite radar. Every event becomes a record that is anchored on a public blockchain, so changing it later would show.</p></div>
      </div>

      <div className="eyebrow">What we believe</div>
      <div className="principles">
        {PRINCIPLES.map(([t, d], i) => (
          <article key={t}><i>{String(i + 1).padStart(2, "0")}</i><b>{t}</b><p className="small muted">{d}</p></article>
        ))}
      </div>

      <div className="numband">
        <div><b><CountUp value={yachts.length} /></b><span>verified yachts</span></div>
        <div><b><CountUp value={marinas.length} /></b><span>partner marinas</span></div>
        <div><b><CountUp value={new Set(recent.map((r) => r.anchor_id)).size} /></b><span>recent on-chain anchors</span></div>
        <div><b>3</b><span>independent signals per position</span></div>
      </div>

      <div className="eyebrow">What we connect</div>
      <div className="sources">{SOURCES.map(([t, d]) => <div key={t}><b>{t}</b><span>{d}</span></div>)}</div>

      <div className="eyebrow">Where we are going</div>
      <ol className="roadmap">
        {ROADMAP.map(([tag, t, d], i) => (
          <li key={t} className={i === 0 ? "now" : ""}><span className="rm-tag">{tag}</span><b>{t}</b><p className="small muted">{d}</p></li>
        ))}
      </ol>

      <div className="ctaband">
        <div><h2>Bring your yacht or marina on board</h2><p className="muted">Owners get a verified passport and live tracking. Marinas get arrivals that prove themselves.</p></div>
        <div className="row"><Link className="btn primary lg" href="/onboard">List your yacht</Link><Link className="btn lg" href="/how-it-works">See how it works</Link></div>
      </div>
    </main>
  );
}
