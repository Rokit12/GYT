"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Head, useData } from "@/components/admin/kit";

type Fix = { lat: number; lon: number; at: string; age_min: number };
type M = {
  id: string; name: string; mmsi: string; home_marina: string; twin_status: string; gps_from_home_m: number | null;
  last_fix: Partial<Record<"gps" | "ais" | "sar" | "device", Fix>> | null; alerts: { severity: "info" | "warn" | "crit"; text: string }[];
};

const age = (f?: Fix) => (f ? (f.age_min < 60 ? `${f.age_min} min` : f.age_min < 2880 ? `${Math.round(f.age_min / 60)} h` : `${Math.round(f.age_min / 1440)} d`) : "—");

export default function Monitoring() {
  const { data, err, reload } = useData<M[]>("/admin/monitoring");
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);
  const crit = data?.filter((m) => m.alerts.some((a) => a.severity === "crit")).length ?? 0;
  return (
    <>
      <Head eyebrow="Overview" title="Yacht monitoring"><span className="small muted">Refreshes every 30 seconds</span></Head>
      {err && <p className="err">{err}</p>}
      <div className="grid g3">
        <div className="panel kpi"><div className="l">Tracked yachts</div><div className="v">{data?.length ?? "—"}</div></div>
        <div className="panel kpi"><div className="l">With signed GPS · phone only</div><div className="v">{data?.filter((m) => m.last_fix?.gps).length ?? "—"} · {data?.filter((m) => !m.last_fix?.gps && m.last_fix?.device).length ?? "—"}</div></div>
        <div className="panel kpi"><div className="l">Critical alerts</div><div className="v" style={{ color: crit ? "var(--crit)" : undefined }}>{crit}</div></div>
      </div>
      <div className="panel tbl">
        <table>
          <thead><tr><th>Yacht</th><th>Signed GPS</th><th>Phone</th><th>AIS</th><th>SAR</th><th className="r">From home</th><th>Alerts</th><th /></tr></thead>
          <tbody>
            {data?.map((m) => {
              const f = m.last_fix ?? {};
              return (
                <tr key={m.id}>
                  <td><b>{m.name}</b><br /><span className="mono small muted">{m.id} · {m.mmsi}</span></td>
                  {(["gps", "device", "ais", "sar"] as const).map((s) => (
                    <td key={s} className="small">
                      {f[s] ? <><span className="mono">{f[s]!.lat.toFixed(3)}, {f[s]!.lon.toFixed(3)}</span><br /><span className={f[s]!.age_min > 60 ? "warn-t" : "muted"}>{age(f[s])} ago</span></> : <span className="muted">none</span>}
                    </td>
                  ))}
                  <td className="r small">{m.gps_from_home_m == null ? "—" : m.gps_from_home_m < 1000 ? `${Math.round(m.gps_from_home_m)} m` : `${(m.gps_from_home_m / 1000).toFixed(1)} km`}</td>
                  <td>{m.alerts.length ? m.alerts.map((a, i) => <div key={i}><span className={`pill ${a.severity}`}>{a.text}</span></div>) : <span className="pill ok">OK</span>}</td>
                  <td><Link className="btn sm" href={`/track?yacht=${m.id}`}>Track</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
