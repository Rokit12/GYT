"use client";

import { useEffect, useState } from "react";

type Row = { leaf: string; event_type: string; yacht_id: string; anchor_id: number };

/** A slow marquee of the newest anchored record hashes. Click one to verify it. */
export default function HashTicker({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/gyt/proofs/recent?limit=14", { cache: "no-store" });
        if (r.ok) setRows(await r.json());
      } catch { /* keep the last list */ }
    }, 20_000);
    return () => clearInterval(t);
  }, []);
  if (!rows.length) return null;
  const items = rows.map((r) => (
    <a key={r.leaf} className="tick" href={`/verify?hash=${r.leaf}`} title={`Verify ${r.event_type} for ${r.yacht_id}`}>
      <span className="tick-type">{r.event_type.replaceAll("_", " ").toLowerCase()}</span>
      <span className="mono">{r.leaf.slice(0, 12)}…{r.leaf.slice(-6)}</span>
      <span className="tick-anchor">#{r.anchor_id}</span>
    </a>
  ));
  return (
    <div className="ticker" aria-label="Newest records anchored on-chain">
      <span className="ticker-label"><span className="dot on" aria-hidden="true" />Anchored now</span>
      <div className="ticker-track">
        <div className="ticker-run">{items}</div>
        <div className="ticker-run" aria-hidden="true">{items}</div>
      </div>
    </div>
  );
}
