"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { call, type Yacht } from "@/lib/api";
import HashCheck from "@/components/HashCheck";
import LiveMap from "@/components/LiveMap";
import Link from "next/link";

type Pos = { source: "gps" | "ais" | "sar" | "device"; observed_at: string; lat: number; lon: number; verified: boolean; accuracy_m: number | null };
type Ev = { id: number; event_type: string; observed_at: string; leaf: string; anchor_id: number | null; root: string | null; chain_tx: string | null };
type Track = { yacht: { id: string; name: string; mmsi: string; twin_status: string; twin_tx: string | null; twin_token_id: number | null }; positions: Pos[]; events: Ev[] };

const RANGES = [[24, "24 h"], [168, "7 days"], [720, "30 days"]] as const;

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

  // The verified track: signed GPS when the yacht has hardware, otherwise the crew's phone fixes.
  const trackSource = data?.positions.some((p) => p.source === "gps") ? "gps" : "device";
  const trackLine = useMemo(
    () => (data?.positions ?? []).filter((p) => p.source === trackSource && (p.source === "gps" || p.verified)).map((p) => [p.lon, p.lat] as [number, number]),
    [data, trackSource],
  );

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
          <header><h3>Verified track</h3><span className="legend small"><i style={{ background: "#c9902a", borderRadius: 2, height: 4 }} />{trackSource === "gps" ? "Signed GPS track" : "Phone track"} <i style={{ borderColor: "#c9902a" }} className="ring" />AIS <i style={{ borderColor: "#c2453f" }} className="ring" />Satellite SAR</span></header>
          <LiveMap height={440} focus={id || null} onSelect={setId}
            track={trackLine} signals={data?.positions.filter((p): p is Pos & { source: "ais" | "sar" } => p.source === "ais" || p.source === "sar").slice(-12)} />
        </div>
        <div className="panel">
          <header><h3>Latest signals</h3></header>
          {(["gps", "device", "ais", "sar"] as const).map((s) => {
            const p = latest[s];
            return (
              <div className="kv" key={s}>
                <span>{s === "gps" ? "Signed GPS" : s === "device" ? "Phone or laptop" : s === "ais" ? "AIS" : "Satellite SAR"}</span>
                <span className="mono small">{p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}${p.source === "device" && p.accuracy_m ? ` ±${Math.round(p.accuracy_m)} m` : ""} · ${new Date(p.observed_at).toLocaleTimeString()}` : "No fix in period"}</span>
              </div>
            );
          })}
          <p className="small muted">A position is trusted when signed GPS, or a crew phone when there is no hardware, agrees with AIS or satellite radar.</p>
          <div className="row">
            <Link className="btn sm" href="/track/device">Track from this device</Link>
            <Link className="btn sm" href={`/map${id ? `?yacht=${encodeURIComponent(id)}` : ""}`}>Open on the map</Link>
          </div>
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
