import { api, type Yacht } from "@/lib/api";
import YachtCard from "@/components/YachtCard";
import LiveMap from "@/components/LiveMap";

export const dynamic = "force-dynamic";

export default async function Yachts({ searchParams }: { searchParams: { q?: string; units?: string; view?: string } }) {
  const all = await api<Yacht[]>("/yachts");
  const q = (searchParams.q ?? "").toLowerCase();
  const map = searchParams.view === "map";
  const list = all.filter(
    (y) => (!q || `${y.name} ${y.id} ${y.marina_name} ${y.flag}`.toLowerCase().includes(q)) && (searchParams.units !== "1" || y.tokenized),
  );
  const qs = (v: string) => `?${new URLSearchParams({ ...(searchParams.q ? { q: searchParams.q } : {}), ...(searchParams.units ? { units: "1" } : {}), view: v })}`;
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
        {map && <input type="hidden" name="view" value="map" />}
        <button>Filter</button>
        <span className="seg" role="group" aria-label="View" style={{ marginLeft: "auto" }}>
          <a className="segl" aria-current={!map ? "true" : undefined} href={qs("grid")}>Gallery</a>
          <a className="segl" aria-current={map ? "true" : undefined} href={qs("map")}>Live map</a>
        </span>
      </form>
      <p className="small muted">{list.length} of {all.length} yachts</p>
      {map && <LiveMap height="min(68vh, 640px)" />}
      <div className="cards2">
        {list.map((y) => <YachtCard key={y.id} y={y} />)}
      </div>
    </main>
  );
}
