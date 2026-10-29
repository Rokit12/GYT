"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { call, type Yacht } from "@/lib/api";
import HashCheck from "@/components/HashCheck";

type Pos = { source: "gps" | "ais" | "sar"; observed_at: string; lat: number; lon: number; verified: boolean };
type Ev = { id: number; event_type: string; observed_at: string; leaf: string; anchor_id: number | null; root: string | null; chain_tx: string | null };
type Track = { yacht: { id: string; name: string; mmsi: string; twin_status: string; twin_tx: string | null; twin_token_id: number | null }; positions: Pos[]; events: Ev[] };

const COLORS = { gps: "var(--accent)", ais: "var(--brass)", sar: "var(--crit)" } as const;
const RANGES = [[24, "24 h"], [168, "7 days"], [720, "30 days"]] as const;

function Plot({ pts }: { pts: Pos[] }) {
  const W = 640, H = 300, pad = 28;
  if (!pts.length) return <div className="plot-empty">No positions in this period yet.</div>;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  let [minLa, maxLa, minLo, maxLo] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const span = Math.max(maxLa - minLa, maxLo - minLo, 0.01);
  const cLa = (minLa + maxLa) / 2, cLo = (minLo + maxLo) / 2;
  [minLa, maxLa, minLo, maxLo] = [cLa - span / 2, cLa + span / 2, cLo - span / 2, cLo + span / 2];
  const x = (lo: number) => pad + ((lo - minLo) / (maxLo - minLo)) * (W - 2 * pad);
  const y = (la: number) => H - pad - ((la - minLa) / (maxLa - minLa)) * (H - 2 * pad);
  const gps = pts.filter((p) => p.source === "gps");
  const last = gps.at(-1) ?? pts.at(-1)!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="plot" role="img" aria-label={`Track with ${pts.length} positions`}>
      <rect x="0" y="0" width={W} height={H} fill="var(--sea)" />
      {[0.25, 0.5, 0.75].map((f) => (
        <g key={f}>
          <line x1={pad + f * (W - 2 * pad)} x2={pad + f * (W - 2 * pad)} y1={pad} y2={H - pad} stroke="var(--line)" />
          <line y1={pad + f * (H - 2 * pad)} y2={pad + f * (H - 2 * pad)} x1={pad} x2={W - pad} stroke="var(--line)" />
        </g>
      ))}
      {gps.length > 1 && <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={gps.map((p) => `${x(p.lon)},${y(p.lat)}`).join(" ")} />}
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.lon)} cy={y(p.lat)} r={p.source === "gps" ? 3 : 5} fill={p.source === "gps" ? "var(--accent)" : "none"}
          stroke={COLORS[p.source]} strokeWidth="2"><title>{`${p.source.toUpperCase()} ${new Date(p.observed_at).toLocaleString()}`}</title></circle>
      ))}
      <circle cx={x(last.lon)} cy={y(last.lat)} r="9" fill="none" stroke="var(--ink)" strokeWidth="2" />
      <text x={pad} y={H - 8} fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">{minLo.toFixed(3)}°</text>
      <text x={W - pad} y={H - 8} fontSize="11" fill="var(--muted)" fontFamily="var(--mono)" textAnchor="end">{maxLo.toFixed(3)}°</text>
      <text x={6} y={pad + 4} fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">{maxLa.toFixed(3)}°</text>
    </svg>
  );
}

function TrackInner() {
  const params = useSearchParams();
  const [yachts, setYachts] = useState<Yacht[]>([]);
  const [id, setId] = useState(params.get("yacht") ?? "");
  const [hours, setHours] = useState<number>(168);
  const [data, setData] = useState<Track | null>(null);
  const [err, setErr] = useState("");
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    call<Yacht[]>("/yachts").then((ys) => {
      setYachts(ys);
      if (!id && ys.length) setId(ys.find((y) => y.last_position)?.id ?? ys[0].id);
    });
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setData(await call<Track>(`/track/${id}?hours=${hours}`));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, hours]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!follow) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [follow, load]);

  const latest = useMemo(() => {
    const out: Partial<Record<Pos["source"], Pos>> = {};
    data?.positions.forEach((p) => { out[p.source] = p; });
    return out;
  }, [data]);

  async function copy(e: Ev) {
    try { await navigator.clipboard.writeText(e.leaf); setCopied(e.id); setTimeout(() => setCopied(null), 1500); } catch { setPicked(e.leaf); }
  }

  return (
    <main className="wrap page">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="eyebrow">Track &amp; verify</div>
          <h1>{data?.yacht.name ?? "Track a yacht"}</h1>
          {data && <p className="lede mono small">{data.yacht.id} · MMSI {data.yacht.mmsi} · twin #{data.yacht.twin_token_id ?? "—"}</p>}
        </div>
        <div className="row">
          <label className="f" htmlFor="ys">Yacht
            <select id="ys" value={id} onChange={(e) => setId(e.target.value)}>
              {yachts.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Period">
            {RANGES.map(([h, l]) => <button key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>{l}</button>)}
          </div>
          <label className="row small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} style={{ width: "auto" }} /> Live (30 s)</label>
        </div>
      </div>
      {err && <p className="err">{err}</p>}

      <div className="grid g-track">
        <div className="panel">
          <header><h3>Verified track</h3><span className="legend small"><i style={{ background: "var(--accent)" }} />GPS (signed) <i style={{ borderColor: "var(--brass)" }} className="ring" />AIS <i style={{ borderColor: "var(--crit)" }} className="ring" />Satellite SAR</span></header>
          <Plot pts={data?.positions ?? []} />
        </div>
        <div className="panel">
          <header><h3>Latest signals</h3></header>
          {(["gps", "ais", "sar"] as const).map((s) => {
            const p = latest[s];
            return (
              <div className="kv" key={s}>
                <span>{s === "gps" ? "Signed GPS" : s === "ais" ? "AIS" : "Satellite SAR"}</span>
                <span className="mono small">{p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · ${new Date(p.observed_at).toLocaleTimeString()}` : "No fix in period"}</span>
              </div>
            );
          })}
          <p className="small muted">A position is trusted when signed GPS agrees with AIS or satellite radar.</p>
        </div>
      </div>

      <div className="panel">
        <header><h3>Record timeline</h3><span className="small muted">Every event is a hash. Anchored hashes are on-chain.</span></header>
        <ol className="timeline">
          {data?.events.map((e) => (
            <li key={e.id}>
              <span className={`dot ${e.anchor_id ? "ok" : "warn"}`} aria-hidden="true" />
              <div className="tl-body">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{e.event_type.replaceAll("_", " ").toLowerCase()}</b>
                  <span className="small muted">{new Date(e.observed_at).toLocaleString()}</span>
                </div>
                <div className="row">
                  <code className="hash">{e.leaf}</code>
                  <span className={`pill ${e.anchor_id ? "ok" : "warn"}`}>{e.anchor_id ? `Anchor #${e.anchor_id}` : "Pending anchor"}</span>
                </div>
                <div className="row">
                  <button className="sm" onClick={() => copy(e)}>{copied === e.id ? "Copied" : "Copy hash"}</button>
                  <button className="sm primary" onClick={() => setPicked(e.leaf)}>Verify</button>
                  {e.chain_tx && <span className="mono small muted">tx {e.chain_tx.slice(0, 18)}…</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="panel" id="verify">
        <header><h3>Verify a hash</h3><span className="small muted">Recomputed in your browser</span></header>
        <HashCheck key={picked} initial={picked} />
      </div>
    </main>
  );
}

export default function TrackPage() {
  return <Suspense><TrackInner /></Suspense>;
}
