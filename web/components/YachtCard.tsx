"use client";

import Link from "next/link";
import { useState } from "react";
import { Tilt } from "./Kinetic";

export type CardYacht = {
  id: string; name: string; loa_m: string | number; flag: string; marina_name: string; tokenized: boolean;
  insurance_verified: boolean; charter_week_usd: string | number | null;
  last_position: { observed_at: string; source: string } | null;
};

const usd = (v: string | number | null) => `$${Math.round(Number(v ?? 0)).toLocaleString()}`;

export function YachtImage({ id, alt, className = "" }: { id: string; alt: string; className?: string }) {
  const [src, setSrc] = useState(`/media/yachts/${id}.jpg`);
  return <img className={className} src={src} alt={alt} loading="lazy" decoding="async" onError={() => setSrc("/media/yachts/default.jpg")} />;
}

export default function YachtCard({ y, compact = false }: { y: CardYacht; compact?: boolean }) {
  const fresh = y.last_position && Date.now() - new Date(y.last_position.observed_at).getTime() < 3600_000;
  return (
    <Tilt className="ycard2">
      <Link href={`/yachts/${y.id}`} className="ycard2-media" aria-label={`${y.name} passport`}>
        <YachtImage id={y.id} alt={`${y.name}, ${Number(y.loa_m)} metre yacht`} />
        <span className="sheen" aria-hidden="true" />
        {fresh && <span className="live-badge"><span className="dot on" aria-hidden="true" />Live</span>}
        <span className="ycard2-len">{Number(y.loa_m)}<small>m</small></span>
      </Link>
      <div className="ycard2-body">
        <span className="eyebrow">{y.id}</span>
        <b className="ycard2-name">{y.name}</b>
        <span className="small muted">{y.flag} · {y.marina_name}</span>
        {!compact && (
          <span className="row">
            <span className="pill ok">Verified</span>
            {y.tokenized && <span className="pill">Units</span>}
            {!y.insurance_verified && <span className="pill crit">Insurance pending</span>}
          </span>
        )}
        <span className="row" style={{ justifyContent: "space-between" }}>
          <span className="small">{usd(y.charter_week_usd)} <span className="muted">/ week</span></span>
          <Link className="btn sm primary" href={`/track?yacht=${y.id}`}>Track</Link>
        </span>
      </div>
    </Tilt>
  );
}
