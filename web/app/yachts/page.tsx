import Link from "next/link";
import { api, usd, type Yacht } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function Yachts({ searchParams }: { searchParams: { q?: string; units?: string } }) {
  const all = await api<Yacht[]>("/yachts");
  const q = (searchParams.q ?? "").toLowerCase();
  const list = all.filter(
    (y) => (!q || `${y.name} ${y.id} ${y.marina_name} ${y.flag}`.toLowerCase().includes(q)) && (searchParams.units !== "1" || y.tokenized),
  );
  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Explore</div>
        <h1>Verified yachts</h1>
        <p className="lede">Every yacht here has a minted passport. Open one to see its record, or track it live.</p>
      </div>
      <form className="row filters" role="search">
        <label className="sr" htmlFor="q">Search</label>
        <input id="q" name="q" defaultValue={searchParams.q} placeholder="Search by name, marina or flag" />
        <label className="row small"><input type="checkbox" name="units" value="1" defaultChecked={searchParams.units === "1"} style={{ width: "auto" }} /> Offers units</label>
        <button>Filter</button>
      </form>
      <p className="small muted">{list.length} of {all.length} yachts</p>
      <div className="fleet">
        {list.map((y) => (
          <div key={y.id} className="yc">
            <span className="yc-hull" aria-hidden="true" />
            <span className="eyebrow">{y.id}</span>
            <b>{y.name}</b>
            <span className="small muted">{Number(y.loa_m)} m · {y.flag} · {y.marina_name}</span>
            <span className="row">
              <span className="pill ok">Verified</span>
              {y.tokenized && <span className="pill">Units</span>}
              {!y.insurance_verified && <span className="pill crit">Insurance pending</span>}
            </span>
            <span className="small">{usd(y.charter_week_usd)} / week charter</span>
            <span className="row">
              <Link className="btn" href={`/yachts/${y.id}`}>Passport</Link>
              <Link className="btn primary" href={`/track?yacht=${y.id}`}>Track</Link>
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}
