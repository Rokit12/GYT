"use client";

import { useEffect, useState } from "react";
import { usd } from "@/lib/api";
import { ConfirmButton, Dialog, Head, call, useAct, useData, useToast } from "@/components/admin/kit";

type Marina = { id: string; name: string; region: string; lat: number; lon: number; arrival_radius_m: number };
type Berth = { id: number; code: string; max_loa_m: string; max_beam_m: string; rate_usd_day: string; services: string; status: string };
type Dash = { berths: Berth[]; occupancy: number; arrivals: { ref: string; yacht: string; arrive: string; status: string }[]; escrow_held_usd: number };
const STATUSES = ["available", "reserved", "occupied", "maintenance"];

export default function Marinas() {
  const marinas = useData<Marina[]>("/marinas");
  const [sel, setSel] = useState<string>("MARINA-DXB-001");
  const dash = useData<Dash>(`/marinas/${sel}/dashboard`);
  const { show, node } = useToast();
  const act = useAct(() => { marinas.reload(); dash.reload(); }, show);
  const [editM, setEditM] = useState<Marina | "new" | null>(null);
  const [editB, setEditB] = useState<Berth | "new" | null>(null);
  const m = marinas.data?.find((x) => x.id === sel);
  useEffect(() => { if (marinas.data && !m && marinas.data[0]) setSel(marinas.data[0].id); }, [marinas.data, m]);
  const curM = editM && editM !== "new" ? editM : null;
  const curB = editB && editB !== "new" ? editB : null;

  return (
    <>
      <Head eyebrow="Operations" title="Marinas & berths">
        <label className="f" htmlFor="ms">Marina<select id="ms" value={sel} onChange={(e) => setSel(e.target.value)}>{marinas.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <button onClick={() => setEditM("new")}>Add marina</button>
      </Head>
      {m && (
        <div className="grid g4">
          <div className="panel kpi"><div className="l">Occupancy</div><div className="v">{Math.round((dash.data?.occupancy ?? 0) * 100)}%</div></div>
          <div className="panel kpi"><div className="l">Berths</div><div className="v">{dash.data?.berths.length ?? "—"}</div></div>
          <div className="panel kpi"><div className="l">Arrivals, 7 days</div><div className="v">{dash.data?.arrivals.length ?? "—"}</div></div>
          <div className="panel kpi"><div className="l">Escrow held</div><div className="v">{usd(dash.data?.escrow_held_usd, true)}</div></div>
        </div>
      )}
      {m && (
        <div className="panel">
          <header>
            <div><h3>{m.name}</h3><span className="small muted mono">{m.id} · {m.region} · {m.lat.toFixed(3)}, {m.lon.toFixed(3)} · arrival radius {m.arrival_radius_m} m</span></div>
            <div className="row" style={{ gap: 6 }}>
              <button className="sm" onClick={() => setEditM(m)}>Edit marina</button>
              <ConfirmButton label="Delete marina" confirm="Delete marina" onConfirm={() => act(() => call(`/admin/marinas/${m.id}`, { method: "DELETE" }), `${m.name} deleted`)} />
              <button className="sm primary" onClick={() => setEditB("new")}>Add berth</button>
            </div>
          </header>
          <div className="tbl"><table>
            <thead><tr><th>Berth</th><th>Max LOA × beam</th><th className="r">Rate / day</th><th>Services</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {dash.data?.berths.map((b) => (
                <tr key={b.id}>
                  <td className="mono"><b>{b.code}</b></td>
                  <td>{Number(b.max_loa_m)} m × {Number(b.max_beam_m)} m</td>
                  <td className="r">{usd(b.rate_usd_day)}</td>
                  <td className="small muted">{b.services}</td>
                  <td>
                    <select aria-label={`Status of ${b.code}`} value={b.status} onChange={(e) => act(() => call(`/admin/berths/${b.id}`, { method: "PATCH", body: JSON.stringify({ status: e.target.value }) }), `${b.code} set to ${e.target.value}`)}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td><div className="row" style={{ gap: 6 }}>
                    <button className="sm" onClick={() => setEditB(b)}>Edit</button>
                    <ConfirmButton label="Delete" confirm="Delete berth" onConfirm={() => act(() => call(`/admin/berths/${b.id}`, { method: "DELETE" }), `${b.code} deleted`)} />
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
      {editM && (
        <Dialog title={curM ? `Edit ${curM.name}` : "Add marina"} onClose={() => setEditM(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = { name: f.get("name"), region: f.get("region"), lat: Number(f.get("lat")), lon: Number(f.get("lon")), arrival_radius_m: Number(f.get("rad")) };
            const ok = curM
              ? await act(() => call(`/admin/marinas/${curM.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Marina updated")
              : await act(() => call("/admin/marinas", { method: "POST", body: JSON.stringify({ ...body, id: f.get("id") }) }), "Marina added");
            if (ok) { if (!curM) setSel(String(f.get("id"))); setEditM(null); }
          }}>
            {!curM && <label className="f" htmlFor="m0">Marina id<input id="m0" name="id" required placeholder="MARINA-LAM-001" /></label>}
            <label className="f" htmlFor="m1">Name<input id="m1" name="name" required defaultValue={curM?.name} /></label>
            <label className="f" htmlFor="m2">Region<input id="m2" name="region" required defaultValue={curM?.region} /></label>
            <label className="f" htmlFor="m3">Latitude<input id="m3" name="lat" type="number" step="0.0001" required defaultValue={curM?.lat} /></label>
            <label className="f" htmlFor="m4">Longitude<input id="m4" name="lon" type="number" step="0.0001" required defaultValue={curM?.lon} /></label>
            <label className="f" htmlFor="m5">Arrival radius (m)<input id="m5" name="rad" type="number" defaultValue={curM?.arrival_radius_m ?? 600} /></label>
            <button className="primary">{curM ? "Save changes" : "Add marina"}</button>
          </form>
        </Dialog>
      )}
      {editB && m && (
        <Dialog title={curB ? `Edit berth ${curB.code}` : `Add berth to ${m.name}`} onClose={() => setEditB(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = { max_loa_m: Number(f.get("l")), max_beam_m: Number(f.get("b")), rate_usd_day: Number(f.get("r")), services: f.get("s") };
            const ok = curB
              ? await act(() => call(`/admin/berths/${curB.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Berth updated")
              : await act(() => call("/admin/berths", { method: "POST", body: JSON.stringify({ ...body, marina_id: m.id, code: f.get("code") }) }), "Berth added");
            if (ok) setEditB(null);
          }}>
            {!curB && <label className="f" htmlFor="b0">Berth code<input id="b0" name="code" required /></label>}
            <label className="f" htmlFor="b1">Max LOA (m)<input id="b1" name="l" type="number" step="0.1" required defaultValue={curB ? Number(curB.max_loa_m) : undefined} /></label>
            <label className="f" htmlFor="b2">Max beam (m)<input id="b2" name="b" type="number" step="0.1" required defaultValue={curB ? Number(curB.max_beam_m) : undefined} /></label>
            <label className="f" htmlFor="b3">Rate per day (USD)<input id="b3" name="r" type="number" required defaultValue={curB ? Number(curB.rate_usd_day) : undefined} /></label>
            <label className="f" htmlFor="b4">Services<input id="b4" name="s" defaultValue={curB?.services} /></label>
            <button className="primary">{curB ? "Save changes" : "Add berth"}</button>
          </form>
        </Dialog>
      )}
      {node}
    </>
  );
}
