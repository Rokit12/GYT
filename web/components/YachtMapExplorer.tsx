"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import OsmMap, { ago, SOURCE, type FleetYacht } from "@/components/OsmMap";

export default function YachtMapExplorer({ initialFocus = null }: { initialFocus?: string | null }) {
  const [ys, setYs] = useState<FleetYacht[]>([]);
  const [focus, setFocus] = useState<string | null>(initialFocus);
  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"all" | "gps" | "device" | "ais">("all");

  const shown = useMemo(
    () => ys.filter((y) => (src === "all" || y.source === src) && (!q || `${y.name} ${y.id} ${y.home}`.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => a.age_s - b.age_s),
    [ys, q, src],
  );
  const only = src === "all" && !q ? undefined : shown.map((y) => y.id);

  return (
    <div className="mapx">
      <aside className="panel mapx-list" aria-label="Yachts on the map">
        <input type="search" placeholder="Search yachts or marinas" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search yachts" />
        <div className="seg" role="group" aria-label="Filter by tracking source">
          {(["all", "gps", "device", "ais"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={src === k} onClick={() => setSrc(k)}>
              {k === "all" ? "All" : k === "gps" ? "GPS" : k === "device" ? "Phone" : "AIS"}
            </button>
          ))}
        </div>
        <ul>
          {shown.map((y) => (
            <li key={y.id}>
              <button type="button" className={`mapx-row ${focus === y.id ? "on" : ""}`} onClick={() => setFocus(y.id)}>
                <i style={{ background: SOURCE[y.source]?.color }} aria-hidden="true" />
                <span className="mapx-name"><b>{y.name}</b><span className="small muted">{SOURCE[y.source]?.label} · {ago(y.age_s)}</span></span>
                <span className="small mono muted">{y.sog != null ? `${y.sog.toFixed(1)} kn` : ""}</span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="small muted" style={{ padding: 12 }}>{ys.length ? "No yachts match." : "Loading positions…"}</li>}
        </ul>
        <p className="small muted">No tracker on board? Owners and crew can <Link href="/track/device">track from their phone</Link>.</p>
      </aside>
      <OsmMap height="min(72vh, 680px)" focus={focus} only={only} onData={setYs} onSelect={setFocus} />
    </div>
  );
}
