"use client";

import { useEffect, useMemo, useState } from "react";
import { Head, call, useData } from "@/components/admin/kit";

type B = {
  id: number; code: string; max_loa_m: number; max_beam_m: number; max_draft_m: number | null; rate_usd_day: number;
  state: "free" | "held" | "booked" | "occupied" | "maintenance"; use_pct: number | null; issues: string[];
  booking: { ref: string; status: string; yacht: string; yacht_id: string; loa_m: number; arrive: string; depart: string } | null;
  hold: { id: number; yacht: string; loa_m: number; expires_at: string } | null;
};
type Board = { counts: Record<string, number>; berths: B[]; flags: { subject: string; summary: string; at: string }[] };
type Marina = { id: string; name: string };
const left = (t: string, now: number) => { const s = Math.max(0, Math.round((new Date(t).getTime() - now) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export default function BerthBoard() {
  const [marina, setMarina] = useState("MARINA-DXB-001");
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [marinas, setMarinas] = useState<Marina[]>([]);
  const [now, setNow] = useState(Date.now());
  const { data, err, reload } = useData<Board>(`/admin/berths/board?marina_id=${marina}&day=${day}`);
  useEffect(() => { call<Marina[]>("/marinas").then(setMarinas).catch(() => {}); }, []);
  useEffect(() => {
    const t = setInterval(() => { reload(); }, 5000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, [reload]);
  const issues = useMemo(() => data?.berths.reduce((n, b) => n + b.issues.length, 0) ?? 0, [data]);

  return (
    <>
      <Head eyebrow="Operations" title="Berth board">
        <select value={marina} onChange={(e) => setMarina(e.target.value)} aria-label="Marina">{marinas.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
        <span className="small muted"><span className="livedot" aria-hidden="true" /> live</span>
      </Head>
      {err && <p className="err">{err}</p>}
      <div className="grid g4">
        {(["free", "held", "booked", "occupied"] as const).map((k) => (
          <div key={k} className="panel kpi"><div className="l">{k === "held" ? "Held right now" : k[0].toUpperCase() + k.slice(1)}</div><div className="v">{data?.counts[k] ?? "—"}</div></div>
        ))}
      </div>
      <div className="board">
        {data?.berths.map((b) => (
          <div key={b.id} className={`bslot st-${b.state} ${b.issues.length ? "has-issue" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}><b>{b.code}</b><span className="small muted">{b.max_loa_m} × {b.max_beam_m} m{b.max_draft_m ? ` · ${b.max_draft_m} m deep` : ""}</span></div>
            <div className="bslot-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, b.use_pct ?? 0)}%` }} /></div>
            {b.booking && <div className="small"><b>{b.booking.yacht}</b> ({b.booking.loa_m} m, {b.use_pct}% of the berth) · {b.booking.status} · {b.booking.ref}</div>}
            {b.hold && <div className="small warn-t">Held by {b.hold.yacht} ({b.hold.loa_m} m) · {left(b.hold.expires_at, now)} left</div>}
            {!b.booking && !b.hold && b.state === "free" && <div className="small muted">Free · ${b.rate_usd_day}/day</div>}
            {b.issues.map((i) => <div key={i} className="small crit-t">⚠ {i}</div>)}
          </div>
        ))}
      </div>
      <div className="panel">
        <header><h3>Autopilot findings for this marina</h3><span className="small muted">{issues} on the board · {data?.flags.length ?? 0} open</span></header>
        {data?.flags.length ? <ul className="aplist">{data.flags.map((f, i) => <li key={i}><span className="pill crit">flagged</span> {f.summary} <span className="small muted">· {new Date(f.at).toLocaleString()}</span></li>)}</ul>
          : <p className="small muted">Nothing needs a look. The autopilot checks fit, holds and arrivals on its own.</p>}
      </div>
    </>
  );
}
