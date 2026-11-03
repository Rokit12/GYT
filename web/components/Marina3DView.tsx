"use client";

import { useEffect, useRef, useState } from "react";
import type { Berth3D, Marina3D, Marina3DState } from "@/lib/marina3d";

/** The 3D marina (three.js), loaded only when shown. Berths and yachts are drawn to scale. */
export default function Marina3DView({ state, onPick, dockCode, height = "min(60vh, 520px)" }: {
  state: Marina3DState; onPick?: (code: string) => void; dockCode?: string | null; height?: number | string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const m = useRef<Marina3D | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [THREE, { createMarina3D }] = await Promise.all([import("three"), import("@/lib/marina3d")]);
        if (dead || !box.current) return;
        m.current = createMarina3D(THREE, box.current, { onPick: (c) => pickRef.current?.(c) });
        m.current.set(latest.current);
        setReady(true);
      } catch (e) {
        setErr("3D view isn't available on this device. The plan view shows the same berths.");
        console.error(e);
      }
    })();
    return () => { dead = true; m.current?.dispose(); m.current = null; };
  }, []);

  const key = JSON.stringify([state.berths?.map((b: Berth3D) => [b.code, b.state, b.best, b.moored?.loa, b.held?.loa]), state.yacht, state.selected]);
  useEffect(() => { if (ready) m.current?.set(state); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key, ready]);
  useEffect(() => { if (ready && dockCode) m.current?.dock(dockCode); }, [dockCode, ready]);

  return (
    <div className="m3d" style={{ height }}>
      <div ref={box} className="m3d-canvas" />
      {!ready && !err && <p className="m3d-msg small">Loading the 3D marina…</p>}
      {err && <p className="m3d-msg small">{err}</p>}
      {ready && (
        <div className="m3d-tools">
          <button type="button" className="sm" onClick={() => m.current?.resetView()}>Reset view</button>
          <span className="small m3d-hint">Drag to turn · pinch or scroll to zoom · tap a berth</span>
        </div>
      )}
    </div>
  );
}
