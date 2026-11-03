"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Head, call, useData } from "@/components/admin/kit";
import type { Berth3D } from "@/lib/marina3d";

const Marina3DView = dynamic(() => import("@/components/Marina3DView"), { ssr: false });

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
  const [view, setView] = useState<"board" | "3d">("board");
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const scene3d = useMemo(() => ({
    berths: (data?.berths ?? []).map((b): Berth3D => ({
      code: b.code, loa: b.max_loa_m, beam: b.max_beam_m, depth: b.max_draft_m,
      state: b.state === "free" ? "available" : b.state,
      moored: b.booking ? { loa: b.booking.loa_m, beam: Math.min(b.max_beam_m * 0.95, b.booking.loa_m * 0.23), name: b.booking.yacht, misfit: b.issues.some((i) => i.startsWith("Booked yacht does not fit")) } : null,
      held: b.hold ? { loa: b.hold.loa_m } : null,
    })),
    yacht: null, selected: null,
  }), [data]);
  const picked = data?.berths.find((b) => b.code === pickedCode) ?? null;
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
      <div className="seg" role="group" aria-label="Board view">
        <button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
        <button aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D marina</button>
      </div>
      {view === "3d" && (
        <div className="panel">
          <Marina3DView state={scene3d} onPick={setPickedCode} height="min(62vh, 560px)" />
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            {picked ? <>Berth <b>{picked.code}</b> ({picked.max_loa_m} m): {picked.booking ? `${picked.booking.yacht}, ${picked.booking.loa_m} m, ${picked.booking.status}` : picked.hold ? `held by ${picked.hold.yacht} (${picked.hold.loa_m} m)` : picked.state}{picked.issues.length ? ` · ${picked.issues.join("; ")}` : ""}</>
              : "Yachts are drawn to scale in their berths; a yacht too long for its berth sticks out over a red band. Tap a berth for details."}
          </p>
        </div>
      )}
      <div className="board" hidden={view === "3d"}>
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
