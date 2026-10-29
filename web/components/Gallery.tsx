"use client";

import { useCallback, useEffect, useState } from "react";
import type { Photo } from "@/lib/photos";

type Shot = { src: string; caption: string; kind: "owner" | "render"; sha?: string };

/** Passport gallery: owner photos first (cover leads), then GYT's rendered illustrations. Lightbox with keys. */
export default function Gallery({ id, name }: { id: string; name: string }) {
  const [owner, setOwner] = useState<Photo[]>([]);
  const [okRender, setOkRender] = useState([true, true]);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch(`/api/gyt/yachts/${id}/photos`, { cache: "no-store" }).then((r) => r.json()).then((b) => setOwner((b.photos ?? []).filter((p: Photo) => p.status === "published"))).catch(() => {});
  }, [id]);
  useEffect(() => {
    load();
    const f = (e: Event) => (e as CustomEvent).detail === id && load();
    window.addEventListener("gyt:photos", f);
    return () => window.removeEventListener("gyt:photos", f);
  }, [id, load]);

  const shots: Shot[] = [
    ...owner.map((p) => ({ src: `/api/gyt${p.url}`, caption: p.caption, kind: "owner" as const, sha: p.sha256 })),
    // GYT's rendered illustrations stand in only until the owner adds real photos.
    ...(owner.length ? [] : [`/media/yachts/${id}.jpg`, `/media/yachts/${id}-b.jpg`].filter((_, i) => okRender[i]).map((src) => ({ src, caption: "", kind: "render" as const }))),
  ].slice(0, 5);

  useEffect(() => {
    if (open === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen((o) => (o === null ? o : (o + 1) % shots.length));
      if (e.key === "ArrowLeft") setOpen((o) => (o === null ? o : (o + shots.length - 1) % shots.length));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, shots.length]);

  if (!shots.length) return null;
  const s = open !== null ? shots[open] : null;
  return (
    <>
      <div className={`gallery n${Math.min(shots.length, 3)}`}>
        {shots.slice(0, 3).map((sh, i) => (
          <button key={sh.src} type="button" className={`gshot ${i === 0 ? "main" : ""}`} onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1} of ${name}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sh.src} alt={sh.caption || `${name}, view ${i + 1}`}
              onError={() => sh.kind === "render" && setOkRender((o) => o.map((v, j) => (sh.src.endsWith(j ? "-b.jpg" : `${id}.jpg`) ? false : v)))} />
            <span className="sheen" aria-hidden="true" />
            <span className={`gtag ${sh.kind}`}>{sh.kind === "owner" ? "Owner photo" : "Illustration"}</span>
            {i === 2 && shots.length > 3 && <span className="gmore">+{shots.length - 3}</span>}
          </button>
        ))}
      </div>
      {s && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${name} photos`} onClick={() => setOpen(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={s.src} alt={s.caption || `${name}, view ${open! + 1}`} onClick={(e) => e.stopPropagation()} />
          <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setOpen((open! + shots.length - 1) % shots.length)} aria-label="Previous photo">←</button>
            <span className="small">{open! + 1} / {shots.length} · {s.kind === "owner" ? `${s.caption || "Owner photo"} · #${s.sha!.slice(0, 8)}` : "Rendered illustration"}</span>
            <button type="button" onClick={() => setOpen((open! + 1) % shots.length)} aria-label="Next photo">→</button>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close">×</button>
          </div>
        </div>
      )}
    </>
  );
}
