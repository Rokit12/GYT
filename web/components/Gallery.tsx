"use client";

import { useEffect, useState } from "react";

/** Passport photo gallery: hover to zoom, click for a full-screen lightbox (arrow keys, Esc). */
export default function Gallery({ id, name }: { id: string; name: string }) {
  const shots = [`/media/yachts/${id}.jpg`, `/media/yachts/${id}-b.jpg`];
  const [ok, setOk] = useState(shots.map(() => true));
  const [open, setOpen] = useState<number | null>(null);
  const live = shots.filter((_, i) => ok[i]);

  useEffect(() => {
    if (open === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((o) => (o === null ? o : (o + 1) % live.length));
      if (e.key === "ArrowLeft") setOpen((o) => (o === null ? o : (o + live.length - 1) % live.length));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, live.length]);

  if (!live.length) return null;
  return (
    <>
      <div className="gallery">
        {shots.map((src, i) => ok[i] && (
          <button key={src} type="button" className={`gshot ${i === 0 ? "main" : ""}`} onClick={() => setOpen(live.indexOf(src))} aria-label={`Open photo ${i + 1} of ${name}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`${name}, view ${i + 1}`} onError={() => setOk((o) => o.map((v, j) => (j === i ? false : v)))} />
            <span className="sheen" aria-hidden="true" />
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name} photos`} onClick={() => setOpen(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={live[open]} alt={`${name}, view ${open + 1}`} onClick={(e) => e.stopPropagation()} />
          <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setOpen((open + live.length - 1) % live.length)} aria-label="Previous photo">←</button>
            <span className="small">{open + 1} / {live.length} · Rendered illustration</span>
            <button type="button" onClick={() => setOpen((open + 1) % live.length)} aria-label="Next photo">→</button>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close">×</button>
          </div>
        </div>
      )}
    </>
  );
}
