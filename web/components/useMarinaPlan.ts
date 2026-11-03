"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import type { Berth3D, Marina3DState } from "@/lib/marina3d";

export type MarinaPlan = {
  plan: { width_m: number; height_m: number; image: string | null } | null;
  berths: { code: string; x: number; z: number; rot: number }[];
};

/** A marina's imported berth plan, if it has one, for the 3D view. */
export function useMarinaPlan(marinaId: string | null | undefined) {
  const [plan, setPlan] = useState<MarinaPlan | null>(null);
  useEffect(() => {
    if (!marinaId) { setPlan(null); return; }
    let dead = false;
    call<MarinaPlan>(`/marinas/${encodeURIComponent(marinaId)}/plan`).then((p) => { if (!dead) setPlan(p); }).catch(() => { if (!dead) setPlan(null); });
    return () => { dead = true; };
  }, [marinaId]);
  return plan;
}

/** Put berths where the plan shows them, with the plan image on the water. */
export function withPlan(state: Marina3DState, plan: MarinaPlan | null): Marina3DState {
  if (!plan?.plan || !plan.berths.length) return state;
  const at = new Map(plan.berths.map((b) => [b.code, b]));
  return {
    ...state,
    plan: { width: plan.plan.width_m, height: plan.plan.height_m, image: plan.plan.image ? `/api/gyt${plan.plan.image}` : null },
    berths: (state.berths ?? []).map((b): Berth3D => { const p = at.get(b.code); return p ? { ...b, at: { x: p.x, z: p.z, rot: p.rot } } : b; }),
  };
}
