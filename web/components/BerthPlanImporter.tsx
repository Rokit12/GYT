"use client";

import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import type { PlanAIResult, PlanSave } from "@/lib/berthplan";

/** Admin: load a berth plan image, find the berths on it, check them, see the 3D marina, save. */
export default function BerthPlanImporter({ marinas, marinaId }: { marinas: { id: string; name: string }[]; marinaId?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const key = marinas.map((m) => m.id).join();

  useEffect(() => {
    if (!marinas.length) return;
    let dead = false;
    let ui: { dispose(): void } | null = null;
    (async () => {
      try {
        const [THREE, { createMarina3D }, { createBerthPlanImporter }] = await Promise.all([import("three"), import("@/lib/marina3d"), import("@/lib/berthplan")]);
        if (dead || !box.current) return;
        ui = createBerthPlanImporter(THREE, createMarina3D, box.current, {
          marinas, marinaId, sampleUrl: "/media/sample-berth-plan.png",
          detectAI: async (file: File) => {
            const r = await fetch(`/api/gyt/admin/marinas/${encodeURIComponent(marinaId ?? marinas[0].id)}/plan/read`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) return { available: false, error: typeof body.detail === "string" ? body.detail : `HTTP ${r.status}` } as PlanAIResult;
            return body as PlanAIResult;
          },
          save: async (p: PlanSave) => {
            if (p.file) {
              const r = await fetch(`/api/gyt/admin/marinas/${encodeURIComponent(p.marinaId)}/plan/image`, { method: "PUT", headers: { "Content-Type": p.file.type || "image/png" }, body: p.file });
              if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(typeof b.detail === "string" ? b.detail : `Image upload failed (${r.status})`); }
            }
            return call<{ message: string }>(`/admin/marinas/${encodeURIComponent(p.marinaId)}/plan`, {
              method: "PUT", body: JSON.stringify({ width_m: p.width_m, height_m: p.height_m, berths: p.berths }),
            });
          },
        });
      } catch (e) {
        console.error(e);
        if (!dead) setErr("The plan importer could not load in this browser.");
      }
    })();
    return () => { dead = true; ui?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, marinaId]);

  return (
    <>
      {err && <p className="err">{err}</p>}
      {!marinas.length && <p className="small">Loading marinas…</p>}
      <div ref={box} />
    </>
  );
}
