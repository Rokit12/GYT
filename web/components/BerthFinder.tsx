"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call, usd } from "@/lib/api";
import dynamic from "next/dynamic";
import type { Berth3D } from "@/lib/marina3d";

const Marina3DView = dynamic(() => import("@/components/Marina3DView"), { ssr: false, loading: () => <p className="small muted">Loading the 3D marina…</p> });
import { useMarinaPlan, withPlan } from "@/components/useMarinaPlan";

/*
  Find a berth for your yacht. The pontoon drawing shows every berth at the marina to scale, with your
  yacht's outline in the selected one, so you can see the fit. The view refreshes every few seconds:
  when another yacht holds a berth it turns amber for everyone at once, and you can't take it.
*/

type Fit = { ok: boolean; reasons: string[]; spare_loa_m: number; snug: boolean; draft_unchecked: boolean };
type Berth = {
  id: number; code: string; max_loa_m: number; max_beam_m: number; max_draft_m: number | null; rate_usd_day: number;
  stay_total_usd: number; services: string; fit: Fit; best_fit?: boolean; hold_id: number | null; held_by: string | null; held_until: string | null;
  state: "available" | "too_small" | "held" | "held_by_you" | "booked" | "booked_by_you" | "maintenance";
};
type Avail = { yacht: { id: string; name: string; loa_m: number; beam_m: number; draft_m: number | null }; nights: number; hold_minutes: number; berths: Berth[] };
type Mine = { id: string; name: string; role: string };
type Marina = { id: string; name: string; region: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const LABEL: Record<Berth["state"], string> = {
  available: "Free", too_small: "Too small", held: "Held by another yacht", held_by_you: "Held for you",
  booked: "Booked", booked_by_you: "Booked by you", maintenance: "Maintenance",
};
const left = (t: string | null, now: number) => {
  if (!t) return "";
  const s = Math.max(0, Math.round((new Date(t).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function BerthFinder() {
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [marinas, setMarinas] = useState<Marina[]>([]);
  const [q, setQ] = useState(() => {
    const t = new Date(); t.setDate(t.getDate() + 14);
    const d = new Date(t); d.setDate(d.getDate() + 3);
    return { yacht: "", marina: "MARINA-DXB-001", arrive: iso(t), depart: iso(d) };
  });
  const [data, setData] = useState<Avail | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [booked, setBooked] = useState<{ ref: string; berth: string; amount: number } | null>(null);
  const prev = useRef<Map<number, Berth["state"]>>(new Map());
  const [view, setView] = useState<"plan" | "3d">(() => { try { return (localStorage.getItem("gyt.berthview") as "plan" | "3d") || "3d"; } catch { return "3d"; } });
  const [dockCode, setDockCode] = useState<string | null>(null);
  const pickView = (v: "plan" | "3d") => { setView(v); try { localStorage.setItem("gyt.berthview", v); } catch { /* storage blocked */ } };

  useEffect(() => {
    call<{ yachts: Mine[] }>("/me/trackable").then((r) => {
      setMine(r.yachts);
      setQ((x) => ({ ...x, yacht: x.yacht || r.yachts[0]?.id || "" }));
    }).catch(() => setMine([]));
    call<Marina[]>("/marinas").then(setMarinas).catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!q.yacht || !q.marina || q.depart <= q.arrive) return;
    try {
      const d = await call<Avail>(`/berths/availability?${new URLSearchParams({ marina_id: q.marina, yacht_id: q.yacht, arrive: q.arrive, depart: q.depart })}`);
      // tell the owner when a berth they were looking at is taken by someone else
      if (quiet) {
        for (const b of d.berths) {
          const was = prev.current.get(b.id);
          if (was === "available" && (b.state === "held" || b.state === "booked")) {
            setNote({ ok: false, t: `Berth ${b.code} was just taken by ${b.held_by ?? "another yacht"}. Your pick moved to the next best fit.` });
            setSel((s) => (s === b.id ? d.berths.find((x) => x.best_fit)?.id ?? null : s));
          }
        }
      }
      prev.current = new Map(d.berths.map((b) => [b.id, b.state]));
      setData(d);
      setErr("");
      setSel((s) => s ?? d.berths.find((b) => b.state === "held_by_you")?.id ?? d.berths.find((b) => b.best_fit)?.id ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [q]);

  useEffect(() => { setData(null); setSel(null); prev.current = new Map(); load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 3000);
    return () => clearInterval(t);
  }, [load]);

  const chosen = data?.berths.find((b) => b.id === sel) ?? null;

  async function hold(b: Berth) {
    if (!data) return;
    setBusy(true); setNote(null);
    try {
      await call(`/berths/${b.id}/hold`, { method: "POST", body: JSON.stringify({ yacht_id: data.yacht.id, arrive: q.arrive, depart: q.depart }) });
      setNote({ ok: true, t: `Berth ${b.code} is held for ${data.yacht.name} for ${data.hold_minutes} minutes. Other yachts now see it as taken.` });
    } catch (e) {
      setNote({ ok: false, t: (e as Error).message });
    }
    setBusy(false);
    load();
  }
  async function release(b: Berth) {
    if (!b.hold_id) return;
    await call(`/berths/holds/${b.hold_id}`, { method: "DELETE" }).catch(() => {});
    setNote({ ok: true, t: `Released berth ${b.code}.` });
    load();
  }
  async function confirm(b: Berth) {
    if (!b.hold_id) return;
    setBusy(true);
    const ref = `BK-${Date.now().toString(36).toUpperCase().slice(-8)}`;
    try {
      const r = await call<{ ref: string; berth: string; amount_usd: number }>(`/berths/holds/${b.hold_id}/confirm`, { method: "POST", body: JSON.stringify({ ref }) });
      setBooked({ ref: r.ref, berth: r.berth, amount: r.amount_usd });
      setDockCode(r.berth);
      setNote(null);
    } catch (e) {
      setNote({ ok: false, t: (e as Error).message });
    }
    setBusy(false);
    load();
  }

  // the same berths for the 3D view, laid out from the marina's berth plan when it has one
  const plan = useMarinaPlan(q.marina);
  const scene3d = useMemo(() => {
    if (!data) return null;
    const heldLoa = (b: Berth) => Number((b.held_by ?? "").match(/([\d.]+) m/)?.[1] ?? b.max_loa_m * 0.8);
    const berths: Berth3D[] = data.berths.map((b) => ({
      code: b.code, loa: b.max_loa_m, beam: b.max_beam_m, depth: b.max_draft_m, state: b.state, best: !!b.best_fit,
      moored: b.state === "booked" ? { loa: Math.round(b.max_loa_m * 0.85), beam: Math.round(b.max_beam_m * 0.8 * 10) / 10 }
        : b.state === "booked_by_you" && b.id !== sel ? { loa: data.yacht.loa_m, beam: data.yacht.beam_m, name: data.yacht.name } : null,
      held: b.state === "held" ? { loa: heldLoa(b) } : null,
    }));
    return withPlan({ berths, yacht: { name: data.yacht.name, loa: data.yacht.loa_m, beam: data.yacht.beam_m }, selected: chosen?.code ?? null }, plan);
  }, [data, chosen, plan]);

  // pontoon drawing, to scale
  const drawing = useMemo(() => {
    if (!data) return null;
    const K = 4.2, GAP = 10, TOP = 34;
    let x = 14;
    const slips = data.berths.map((b) => {
      const w = Math.max(40, b.max_beam_m * 7), h = b.max_loa_m * K;
      const s = { b, x, w, h };
      x += w + GAP;
      return s;
    });
    const H = TOP + Math.max(...slips.map((s) => s.h)) + 40;
    return { slips, W: x + 6, H, K, TOP };
  }, [data]);

  if (mine === null) return <p className="muted">Loading your yachts…</p>;
  if (!mine.length) {
    return (
      <div className="panel empty-state">
        <h2>Add your yacht first</h2>
        <p className="muted">Berths are matched to a yacht&apos;s length, beam and draft, so you need a yacht on GYT, as its owner or crew.</p>
        <div className="row"><Link className="btn primary" href="/onboard">List your yacht</Link></div>
      </div>
    );
  }

  return (
    <div className="bf">
      <form className="panel bf-q" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label className="f">Yacht<select value={q.yacht} onChange={(e) => setQ({ ...q, yacht: e.target.value })}>
          {mine.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></label>
        <label className="f">Marina<select value={q.marina} onChange={(e) => setQ({ ...q, marina: e.target.value })}>
          {marinas.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="f">Arrive<input type="date" value={q.arrive} onChange={(e) => setQ({ ...q, arrive: e.target.value })} /></label>
        <label className="f">Depart<input type="date" value={q.depart} min={q.arrive} onChange={(e) => setQ({ ...q, depart: e.target.value })} /></label>
        <span className="bf-live small"><span className="livedot" aria-hidden="true" /> Live: updates every 3 s</span>
      </form>

      {err && <p className="err">{err}</p>}
      {note && <p className={`banner ${note.ok ? "ok" : "warn"}`} role="status">{note.t}</p>}
      {booked && (
        <div className="panel bf-done" role="status">
          <b>Booked: berth {booked.berth}, ref {booked.ref}</b>
          <span className="small muted">{usd(booked.amount)} is held in escrow and released to the marina only when your arrival is proven.</span>
          <Link className="btn sm" href="/account">See it in My GYT</Link>
        </div>
      )}

      {data && drawing && (
        <>
          <div className="panel">
            <header><h3>{data.yacht.name}: {data.yacht.loa_m} m × {data.yacht.beam_m} m{data.yacht.draft_m ? `, draft ${data.yacht.draft_m} m` : ""}</h3>
              <span className="legend bf-legend small"><span><i className="swc swc-free" />Fits</span><span><i className="swc swc-best" />Best fit</span><span><i className="swc swc-held" />Held by another yacht</span><span><i className="swc swc-mine" />Yours</span><span><i className="swc swc-small" />Too small</span><span><i className="swc swc-booked" />Booked</span></span></header>
            <div className="seg bf-view" role="group" aria-label="Berth view">
              <button type="button" aria-pressed={view === "3d"} onClick={() => pickView("3d")}>3D marina</button>
              <button type="button" aria-pressed={view === "plan"} onClick={() => pickView("plan")}>Plan</button>
            </div>
            {view === "3d" && scene3d && (
              <Marina3DView state={scene3d} dockCode={dockCode}
                onPick={(code) => { const b = data.berths.find((x) => x.code === code); if (b) setSel(b.id); }} />
            )}
            <div className="bf-scroll" hidden={view === "3d"}>
              <svg className="pontoon" viewBox={`0 0 ${drawing.W} ${drawing.H}`} width={drawing.W} height={drawing.H} role="img"
                aria-label={`Berths at this marina drawn to scale, with ${data.yacht.name}'s outline in the selected berth`}>
                <rect x="0" y="6" width={drawing.W} height="20" rx="4" className="pt-deck" />
                <text x="10" y="20" className="pt-lbl">Pontoon</text>
                {drawing.slips.map(({ b, x, w, h }) => {
                  const on = sel === b.id;
                  const cls = b.state === "available" ? (b.best_fit ? "best" : "free") : b.state === "held_by_you" || b.state === "booked_by_you" ? "mine"
                    : b.state === "too_small" ? "small" : b.state === "held" ? "held" : "booked";
                  const yl = data.yacht.loa_m * drawing.K, yw = Math.min(w - 6, data.yacht.beam_m * 7);
                  return (
                    <g key={b.id} className={`slip ${cls} ${on ? "on" : ""}`} onClick={() => setSel(b.id)} tabIndex={0} role="button"
                      aria-label={`Berth ${b.code}, up to ${b.max_loa_m} metres, ${LABEL[b.state]}`} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSel(b.id); }}>
                      <rect x={x} y={drawing.TOP} width={w} height={h} rx="3" className="sl-box" />
                      {on && (
                        <path className={`ghost ${b.fit.ok ? "" : "bad"}`}
                          d={`M${x + w / 2} ${drawing.TOP + 4} l${yw / 2} ${yl * 0.18} v${yl * 0.72} q0 ${yl * 0.1} -${yw / 2} ${yl * 0.1} q-${yw / 2} 0 -${yw / 2} -${yl * 0.1} v-${yl * 0.72} z`} />
                      )}
                      <text x={x + w / 2} y={drawing.TOP + h + 14} className="sl-code">{b.code}</text>
                      <text x={x + w / 2} y={drawing.TOP + h + 27} className="sl-size">{b.max_loa_m} m</text>
                      {b.best_fit && <text x={x + w / 2} y={drawing.TOP - 4} className="sl-star">★</text>}
                      {(b.state === "held" || b.state === "held_by_you") && <text x={x + w / 2} y={drawing.TOP + 16} className="sl-clock">{left(b.held_until, now)}</text>}
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {chosen && (
            <div className="panel bf-act">
              <div>
                <b>Berth {chosen.code}</b> <span className="muted small">· {LABEL[chosen.state]}</span>
                <div className="small muted">{chosen.services}</div>
              </div>
              {chosen.state === "available" && <button className="primary lg" disabled={busy} onClick={() => hold(chosen)}>Hold berth {chosen.code} for {data.hold_minutes} min</button>}
              {chosen.state === "held_by_you" && (
                <div className="row">
                  <span className="small">Held for you · <b className="mono">{left(chosen.held_until, now)}</b> left</span>
                  <button className="primary lg" disabled={busy} onClick={() => confirm(chosen)}>Confirm and pay {usd(chosen.stay_total_usd)} into escrow</button>
                  <button onClick={() => release(chosen)}>Release</button>
                </div>
              )}
              {chosen.state === "held" && <span className="small">Another yacht found this berth first. {data.berths.find((b) => b.best_fit) ? `Try ${data.berths.find((b) => b.best_fit)!.code}, the best free fit.` : ""}</span>}
              {chosen.state === "too_small" && <span className="small">{chosen.fit.reasons.join("; ")}. GYT never offers a berth your yacht doesn&apos;t fit.</span>}
              {(chosen.state === "booked" || chosen.state === "booked_by_you" || chosen.state === "maintenance") && <span className="small muted">Not available for these dates.</span>}
            </div>
          )}
          <div className="bf-grid">
            {data.berths.map((b) => (
              <button key={b.id} type="button" className={`bcard s-${b.state} ${b.best_fit ? "best" : ""} ${sel === b.id ? "on" : ""}`} onClick={() => setSel(b.id)}>
                <span className="row" style={{ justifyContent: "space-between" }}><b>Berth {b.code}</b><span className={`pill ${b.state === "available" ? "ok" : b.state === "held" || b.state === "too_small" ? "warn" : b.state.endsWith("you") ? "info" : ""}`}>{b.best_fit ? "★ Best fit" : LABEL[b.state]}</span></span>
                <span className="small muted">Up to {b.max_loa_m} m × {b.max_beam_m} m{b.max_draft_m ? `, ${b.max_draft_m} m deep` : ""}</span>
                <span className="small">{b.fit.ok ? (b.fit.snug ? `Snug: ${b.fit.spare_loa_m} m to spare` : `${b.fit.spare_loa_m} m to spare`) : b.fit.reasons[0]}</span>
                {b.state === "held" && <span className="small warn-t">Held by {b.held_by} · frees in {left(b.held_until, now)} unless they book</span>}
                <span className="mono small">{usd(b.rate_usd_day)}/day · {usd(b.stay_total_usd)} for {data.nights} night{data.nights === 1 ? "" : "s"}</span>
              </button>
            ))}
          </div>

        </>
      )}
    </div>
  );
}
