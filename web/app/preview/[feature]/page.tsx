import Link from "next/link";
import { notFound } from "next/navigation";
import { api, type Yacht } from "@/lib/api";
import LiveMap from "@/components/LiveMap";
import { KineticHeadline } from "@/components/Kinetic";

export const dynamic = "force-dynamic";

type F = {
  eyebrow: string; title: string; lede: string; img: string; time: string;
  perks: [string, string, string][]; steps: [string, string][]; need?: string[]; demo: "map" | "earn" | "account" | "onboard";
};
const FEATURES: Record<string, F> = {
  track: {
    eyebrow: "Track & verify", title: "Follow any yacht, and check every record.", img: "YACHT-000002",
    lede: "See where a yacht is right now, how it got there, and the proof behind every position, booking and inspection.",
    time: "Free · ready in under a minute",
    perks: [["⌖", "Live position", "Signed onboard GPS or a crew phone, cross-checked with public AIS and satellite radar."],
      ["⚠", "Alerts that matter", "Know when a yacht arrives, leaves, or goes quiet on AIS."],
      ["#", "Full record timeline", "Every event is a hash anchored on-chain, newest first."],
      ["✓", "Verify in your browser", "Recompute any proof yourself, no trust in GYT needed."]],
    steps: [["Create a free account", "Name, email and a password. No card."], ["Follow a yacht", "From its passport or straight from the map."], ["Open the tracker", "Live map, signals and the record timeline in one place."]],
    demo: "map",
  },
  device: {
    eyebrow: "Track from your phone", title: "No tracker on board? Your phone is enough.", img: "YACHT-000005",
    lede: "Owners and their captains can share a phone's or laptop's location as the yacht's position, straight from the browser. Nothing to install or fit.",
    time: "Free · works in any modern browser",
    perks: [["⌖", "Phone becomes the tracker", "Press Start aboard; the yacht moves on the GYT map as you do."],
      ["⇅", "Works with patchy signal", "Fixes are saved on the device at sea and sent when you're back in range."],
      ["👥", "Share with your captain", "Owners add crew by email so they can track from their own phone."],
      ["#", "Recorded and labelled", "Every session is a hashed event; positions are marked as phone fixes."]],
    steps: [["Create a free account", "Name, email and a password."], ["List your yacht, or be added as crew", "Owners list the yacht; captains are added by the owner."], ["Open Track from this device", "Press Start and keep the page open."]],
    demo: "map",
  },
  earn: {
    eyebrow: "Use or Earn", title: "Own a share of a yacht, then use it or earn from it.", img: "YACHT-000007",
    lede: "Units give you a stake in one yacht's company. Each year, spend their credits on nights aboard any verified yacht, or pool them and share charter income.",
    time: "Eligibility check through a licensed partner",
    perks: [["◈", "Clear unit pricing", "1 unit = latest independent valuation ÷ units issued."],
      ["⚓", "Use", "Credits for nights aboard any verified yacht, with a holder discount."],
      ["$", "Earn", "Pool your share and receive payouts when guests book."],
      ["⛨", "Protected transfers", "Every transfer is checked against eligibility, caps and lock-ups."]],
    steps: [["Create an account", "Free, in a minute."], ["Pass eligibility", "Identity and suitability checks through a licensed partner."], ["Choose a yacht and mode", "Pick Use or Earn per holding, each year."]],
    demo: "earn",
  },
  onboard: {
    eyebrow: "List your yacht", title: "Give your yacht a passport people can trust.", img: "YACHT-000004",
    lede: "Upload your documents and photos, fit a signed tracker, and get a verified digital passport with live tracking and a record that builds itself.",
    time: "About 15 minutes · save and finish later",
    perks: [["▣", "Verified passport", "Registry, survey and insurance checked once, hashed for good."],
      ["📷", "Your photos", "Upload your own photos; pick the cover shown across GYT."],
      ["⌖", "Three-signal tracking", "Positions that prove themselves, even when AIS is off."],
      ["◈", "Optional units", "Open a charter calendar or offer units through a licensed partner."]],
    steps: [["Create an account", "An admin approves owners before listing."], ["Add vessel, documents and photos", "Files are fingerprinted in your browser before upload."], ["We verify and mint", "Your passport goes live with tracking."]],
    need: ["Certificate of registry", "Latest survey or class certificate", "Insurance certificate", "MMSI number (if fitted with AIS)", "A few good photos (JPEG, PNG or WebP)"],
    demo: "onboard",
  },
  account: {
    eyebrow: "My GYT", title: "Your yachts, their activity and your units, in one place.", img: "YACHT-000001",
    lede: "Follow yachts, see what happens to them as it happens, keep an eye on what your units are worth, and set how you want to be told.",
    time: "Free account",
    perks: [["★", "Followed yachts", "Live status, last fix and inspection flags at a glance."],
      ["≡", "Activity feed", "Movements, arrivals, maintenance, bookings and ownership, filterable."],
      ["◈", "Holdings", "Units, share of each yacht and indicative value."],
      ["⚙", "Your settings", "Profile, alerts, password and wallet in one place."]],
    steps: [["Create an account", "Three short steps."], ["Follow a few yachts", "Pick them during sign-up or later."], ["Open My GYT", "Everything updates every 30 seconds."]],
    demo: "account",
  },
};

export default async function FeaturePreview({ params, searchParams }: { params: { feature: string }; searchParams: { next?: string } }) {
  const f = FEATURES[params.feature];
  if (!f) notFound();
  const next = searchParams.next ?? "/";
  const q = `?next=${encodeURIComponent(next)}`;
  const yachts = f.demo === "earn" || f.demo === "account" ? await api<Yacht[]>("/yachts").catch(() => [] as Yacht[]) : [];
  const ex = yachts.find((y) => y.id === "YACHT-000002") ?? yachts.find((y) => y.tokenized);
  const price = ex?.valuation_usd && ex.units_total ? Number(ex.valuation_usd) / ex.units_total : null;
  return (
    <main className="wrap page fpv">
      <section className="fpv-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/media/yachts/${f.img}.jpg`} alt="" aria-hidden="true" />
        <div className="fpv-shade" aria-hidden="true" />
        <div className="fpv-in">
          <div className="eyebrow">{f.eyebrow}</div>
          <KineticHeadline className="display" text={f.title} />
          <p className="lede">{f.lede}</p>
          <div className="row">
            <Link className="btn primary lg" href={`/signup${q}`}>Create a free account</Link>
            <Link className="btn lg" href={`/signin${q}`}>I have an account</Link>
          </div>
          <span className="small fpv-time">{f.time}</span>
        </div>
      </section>

      <div className="perks">
        {f.perks.map(([i, t, d]) => <article key={t}><span className="pk" aria-hidden="true">{i}</span><b>{t}</b><p className="small muted">{d}</p></article>)}
      </div>

      <section className="fpv-demo">
        <div className="flowhead"><div className="eyebrow">See it before you sign up</div>
          <h2>{f.demo === "map" ? "This is the live map, right now" : f.demo === "earn" ? "What one unit is, in real numbers" : f.demo === "onboard" ? "What you will need" : "What your dashboard looks like"}</h2></div>
        {f.demo === "map" && <LiveMap height={420} />}
        {f.demo === "earn" && ex && price && (
          <div className="earn-ex">
            <div className="u-eq"><div><span className="small muted">{ex.name} valuation</span><b>${(Number(ex.valuation_usd) / 1e6).toFixed(1)}M</b></div><span className="op">÷</span>
              <div><span className="small muted">Units issued</span><b>{ex.units_total.toLocaleString()}</b></div><span className="op">=</span>
              <div><span className="small muted">1 unit</span><b>${Math.round(price).toLocaleString()}</b></div></div>
            <div className="earn-cards">
              <div><span className="eyebrow">Holding 100 units</span><b>${Math.round(price * 100).toLocaleString()}</b><span className="small muted">{(100 / ex.units_total * 100).toFixed(2)}% of {ex.name}</span></div>
              <div><span className="eyebrow">Use</span><b>≈ ${Math.round(price * 100 * 0.06).toLocaleString()} / year</b><span className="small muted">in stay credits (6% of stake), illustrative</span></div>
              <div><span className="eyebrow">Earn</span><b>Your share of bookings</b><span className="small muted">Paid per booking; depends on occupancy. Not guaranteed.</span></div>
            </div>
            <Link href={`/yachts/${ex.id}#units`}>See who holds {ex.name}&apos;s units →</Link>
          </div>
        )}
        {f.demo === "onboard" && (
          <div className="need">
            <ul>{f.need!.map((n) => <li key={n}>{n}</li>)}</ul>
            <div className="need-photo"><span aria-hidden="true">📷</span><b>Photos make the difference</b><p className="small muted">Your cover photo replaces our illustration on the map, in search and on your passport. Each upload is fingerprinted and dated on-chain.</p></div>
          </div>
        )}
        {f.demo === "account" && (
          <div className="acct-demo" aria-label="Example dashboard">
            <span className="demo-tag">Example</span>
            <div className="kpis">
              <div className="kpi2"><span>Following</span><b>3</b><small>yachts</small></div><div className="kpi2"><span>Units held</span><b>250</b><small>across 2 yachts</small></div>
              <div className="kpi2"><span>Indicative value</span><b>$151,250</b><small>at latest valuations</small></div><div className="kpi2"><span>Activity</span><b>42</b><small>records in 7 days</small></div>
            </div>
            <div className="demo-feed">
              {yachts.slice(0, 3).map((y, i) => (
                <div key={y.id} className="fi"><span className="fi-ic" aria-hidden="true">{["⚓", "⌖", "✎"][i]}</span>
                  <span><b>{["Arrival proof", "Position", "Maintenance log"][i]}</b> <span className="muted">· {y.name}</span><br /><span className="small muted mono">anchored · {["2 min", "14 min", "3 h"][i]} ago</span></span></div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="flowhead"><div className="eyebrow">How it starts</div><h2>Three steps</h2></div>
        <ol className="steps3">{f.steps.map(([t, d], i) => <li key={t}><span className="n">{i + 1}</span><b>{t}</b><span className="small muted">{d}</span></li>)}</ol>
      </section>

      <div className="ctaband">
        <div><h2>Ready when you are</h2><p className="muted">Browsing, tracking and verifying are free. An admin approves accounts before bookings and investments.</p></div>
        <div className="row"><Link className="btn primary lg" href={`/signup${q}`}>Create a free account</Link><Link className="btn lg" href={`/signin${q}`}>Sign in</Link></div>
      </div>
    </main>
  );
}
