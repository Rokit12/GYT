"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { photosChanged, shrink, uploadPhoto, type Photo } from "@/lib/photos";

type Q = { key: string; name: string; preview: string; p: number; err?: string; done?: boolean };

/** Owner/admin photo manager: drop or pick images, see progress, set the cover, caption, delete. */
export default function PhotoManager({ yachtId, name }: { yachtId: string; name: string }) {
  const [can, setCan] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [queue, setQueue] = useState<Q[]>([]);
  const [drag, setDrag] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/gyt/yachts/${yachtId}/photos`, { cache: "no-store" });
    if (r.ok) { const b = await r.json(); setCan(b.can_manage); setPhotos(b.photos); }
  }, [yachtId]);
  useEffect(() => { load(); }, [load]);

  async function add(files: FileList | File[]) {
    const list = Array.from(files).slice(0, Math.max(0, 12 - photos.length));
    for (const f of list) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setQueue((q) => [...q, { key, name: f.name, preview: URL.createObjectURL(f), p: 0 }]);
      try {
        const blob = await shrink(f);
        await uploadPhoto(yachtId, blob, "", (p) => setQueue((q) => q.map((x) => (x.key === key ? { ...x, p } : x))));
        setQueue((q) => q.map((x) => (x.key === key ? { ...x, p: 1, done: true } : x)));
        setTimeout(() => setQueue((q) => q.filter((x) => x.key !== key)), 1200);
        await load(); photosChanged(yachtId);
      } catch (e) {
        setQueue((q) => q.map((x) => (x.key === key ? { ...x, err: (e as Error).message } : x)));
      }
    }
  }
  async function patch(id: number, body: object) {
    await fetch(`/api/gyt/yachts/${yachtId}/photos/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await load(); photosChanged(yachtId);
  }
  async function remove(id: number) {
    await fetch(`/api/gyt/yachts/${yachtId}/photos/${id}`, { method: "DELETE" });
    setConfirm(null); await load(); photosChanged(yachtId);
  }

  if (!can) return null;
  return (
    <div className="panel photomgr" id="photos">
      <header><h3>Your photos</h3><span className="small muted">{photos.length} of 12 · visible to everyone · the starred photo is the cover</span></header>
      <div
        className={`drop ${drag ? "over" : ""}`} role="button" tabIndex={0}
        onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        aria-label={`Upload photos of ${name}`}
      >
        <span className="drop-ic" aria-hidden="true">⇪</span>
        <b>Drop photos here, or click to choose</b>
        <span className="small muted">JPEG, PNG or WebP · up to 8 MB each · we resize large photos in your browser before uploading</span>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
      </div>
      {(queue.length > 0 || photos.length > 0) && (
        <div className="pgrid">
          {queue.map((q) => (
            <figure key={q.key} className={`ph up ${q.err ? "bad" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={q.preview} alt="" />
              <figcaption>{q.err ? <span className="ferr">{q.err}</span> : q.done ? "✓ Uploaded" : <span className="prog"><i style={{ width: `${Math.round(q.p * 100)}%` }} /></span>}</figcaption>
              {q.err && <button className="sm ph-x" onClick={() => setQueue((x) => x.filter((y) => y.key !== q.key))} aria-label="Dismiss">×</button>}
            </figure>
          ))}
          {photos.map((p) => (
            <figure key={p.id} className={`ph ${p.is_cover ? "cover" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/gyt${p.url}`} alt={p.caption || `${name} photo`} loading="lazy" />
              <button className={`star ${p.is_cover ? "on" : ""}`} onClick={() => !p.is_cover && patch(p.id, { is_cover: true })} aria-label={p.is_cover ? "Cover photo" : "Make this the cover"} title={p.is_cover ? "Cover photo" : "Make cover"}>★</button>
              <figcaption>
                <input defaultValue={p.caption} placeholder="Add a caption" maxLength={140} aria-label="Caption"
                  onBlur={(e) => e.target.value !== p.caption && patch(p.id, { caption: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
                {confirm === p.id
                  ? <span className="row" style={{ gap: 4 }}><button className="sm danger" onClick={() => remove(p.id)}>Delete</button><button className="sm" onClick={() => setConfirm(null)}>Keep</button></span>
                  : <button className="sm ghost" onClick={() => setConfirm(p.id)} aria-label="Delete photo">🗑</button>}
              </figcaption>
              <span className="ph-hash mono" title={`SHA-256 ${p.sha256}`}>#{p.sha256.slice(0, 8)}</span>
            </figure>
          ))}
        </div>
      )}
      <p className="small muted">Each upload is fingerprinted (SHA-256) and recorded as a dated event, so anyone can later prove the photo existed on that day.</p>
    </div>
  );
}
