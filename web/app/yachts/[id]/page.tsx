import Link from "next/link";
import { notFound } from "next/navigation";
import { api, usd, type Passport } from "@/lib/api";
import VerifyProof from "@/components/VerifyProof";
import Gallery from "@/components/Gallery";
import LiveMap from "@/components/LiveMap";

export const dynamic = "force-dynamic";

export default async function PassportPage({ params }: { params: { id: string } }) {
  let y: Passport;
  try {
    y = await api<Passport>(`/yachts/${params.id}`);
  } catch {
    notFound();
  }
  const c = y.condition;
  const tone = c.score >= 85 ? "ok" : c.score >= 70 ? "warn" : "crit";
  const rows: [string, React.ReactNode][] = [
    ["Flag / registry", y.flag],
    ["MMSI", <span className="mono" key="m">{y.mmsi ?? "—"}</span>],
    ["Length / beam", `${Number(y.loa_m)} m / ${Number(y.beam_m)} m`],
    ["Built", `${y.year_built ?? "—"} · ${y.builder ?? ""}`],
    ["Home marina", `${y.marina_name}${y.berth_code ? ` · berth ${y.berth_code}` : ""}`],
    ["Ownership units", y.tokenized ? y.units_total.toLocaleString() : "Not issued"],
    ["Indicative valuation", usd(y.valuation_usd)],
    ["Weekly charter rate", usd(y.charter_week_usd)],
    ["Inspection", <span key="i" className={`pill ${y.inspection_status === "VALID" ? "ok" : "warn"}`}>{y.inspection_status}</span>],
    ["Insurance", <span key="n" className={`pill ${y.insurance_verified ? "ok" : "crit"}`}>{y.insurance_verified ? "Verified" : "Not verified"}</span>],
  ];
  return (
    <main className="wrap page">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="eyebrow">{y.id} · Yacht passport</div>
          <h1>{y.name}</h1>
        </div>
        <Link className="btn primary" href={`/track?yacht=${y.id}`}>Track this yacht</Link>
      </div>
      <Gallery id={y.id} name={y.name} />
      <div className="grid g2">
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="panel">
            {rows.map(([k, v]) => (
              <div className="kv" key={k}><span>{k}</span><span>{v}</span></div>
            ))}
          </div>
          <div className="panel">
            <header><h3>Where it is now</h3><span className="small muted">Live · signed GPS and AIS</span></header>
            <LiveMap height={320} focus={y.id} showTraffic={false} />
          </div>
        </div>
        <div className="grid">
          <div className="score">
            <div>
              <div className="eyebrow">Condition score</div>
              <div className="big" style={{ color: `var(--${tone})` }}>{c.score}<span className="small muted">/100</span></div>
            </div>
            <div>
              <div className="small">
                Verified valuation band <b className="mono">{usd(c.valuation_band_usd[0], true)} – {usd(c.valuation_band_usd[1], true)}</b>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                {c.factors.map((f) => (
                  <span key={f.label} className={`pill ${f.points < 0 ? "warn" : "ok"}`}>{f.label} {f.points ? f.points : ""}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="panel">
            <header><h3>Latest anchored proof</h3>{y.latest_event?.pending ? <span className="small muted">{y.latest_event.pending} newer event(s) wait for the next anchor</span> : null}</header>
            {y.latest_event ? (
              <VerifyProof eventId={y.latest_event.id} eventType={y.latest_event.event_type} leaf={y.latest_event.leaf} />
            ) : (
              <p className="muted small">No events recorded yet.</p>
            )}
          </div>
          <div className="panel">
            <header><h3>Verified documents</h3><span className="small muted">Hashes only; files stay encrypted off-chain</span></header>
            {y.documents.length ? (
              y.documents.map((d) => (
                <div className="kv" key={d.sha256}><span>{d.kind}</span><span className="mono small">{d.sha256.slice(0, 16)}…</span></div>
              ))
            ) : (
              <p className="muted small">No documents on file.</p>
            )}
            {y.docs_root && <div className="hashbox" style={{ marginTop: 8 }}><b>Docs Merkle root</b> {y.docs_root}</div>}
          </div>
        </div>
      </div>
    </main>
  );
}
