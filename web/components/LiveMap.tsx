"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";

/*
  Live map. Basemap: OpenFreeMap (free, no key; © OpenMapTiles, data © OpenStreetMap contributors).
  Live data:
    /live/fleet    our minted yachts, latest signed GPS or AIS fix, with a short trail
    /live/vessels  every yacht heard on public AIS: aisstream.io (key) around partner marinas, and
                   Digitraffic (no key, Finnish waters)
  If the tile host cannot be reached, the map falls back to a bundled Natural Earth coastline.
*/

const STYLE_LIGHT = process.env.NEXT_PUBLIC_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = process.env.NEXT_PUBLIC_MAP_STYLE_DARK ?? "https://tiles.openfreemap.org/styles/dark";
const OFFLINE = "/map/offline-style.json";

type FleetProps = { id: string; name: string; loa_m: number; source: string; age_s: number; sog: number | null; cog: number | null; home: string; trail: number[][] | null };
type Fleet = { features: { geometry: { coordinates: [number, number] }; properties: FleetProps }[] };
type Status = { enabled: boolean; status: string; provider: string; vessels: number; error: string | null };
type Marina = { id: string; name: string; lat: number; lon: number };

export type LiveMapProps = {
  height?: number | string;
  focus?: string | null;            // yacht id to follow
  track?: [number, number][];       // extra line to draw (e.g. the Track page's verified track)
  signals?: { source: "ais" | "sar" | "gps"; lon: number; lat: number }[];
  showTraffic?: boolean;
  onSelect?: (id: string) => void;
  initial?: { center: [number, number]; zoom: number };
  only?: string[];                  // show just these yachts (e.g. the ones you follow)
};

const api = (p: string) => fetch(`/api/gyt${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
const ago = (s: number) => (s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function yachtEl(name: string, onClick: () => void) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ym";
  el.setAttribute("aria-label", `${name}, open on the map`);
  el.innerHTML = `<span class="ym-pulse"></span><svg class="ym-hull" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L17 15 Q12 22 7 15 Z"/></svg><span class="ym-name">${esc(name)}</span>`;
  el.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return el;
}

export default function LiveMap({ height = 460, focus = null, track, signals, showTraffic = true, onSelect, initial, only }: LiveMapProps) {
  const onlyRef = useRef(only);
  onlyRef.current = only;
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef(new Map<string, { m: Marker; from: [number, number]; to: [number, number]; t0: number }>());
  const [status, setStatus] = useState<Status | null>(null);
  const [counts, setCounts] = useState({ fleet: 0, traffic: 0 });
  const [basemap, setBasemap] = useState<"live" | "offline">("live");
  const [sel, setSel] = useState<FleetProps | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // ---------- create the map once ----------
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const timers: ReturnType<typeof setInterval>[] = [];
    (async () => {
      const ml = (await import("maplibre-gl")).default;
      if (cancelled || !box.current) return;
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const m = new ml.Map({
        container: box.current,
        style: dark ? STYLE_DARK : STYLE_LIGHT,
        center: initial?.center ?? [40, 22],
        zoom: initial?.zoom ?? 1.6,
        attributionControl: { compact: true, customAttribution: 'Live AIS: <a href="https://aisstream.io" target="_blank" rel="noopener">aisstream.io</a>, <a href="https://www.digitraffic.fi/en/" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a> (CC BY 4.0)' },
        cooperativeGestures: false,
      });
      map.current = m;
      m.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-right");
      m.addControl(new ml.FullscreenControl(), "top-right");
      m.addControl(new ml.ScaleControl({ unit: "nautical" }), "bottom-left");

      let fellBack = false;
      m.on("error", (e) => {
        const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
        if (!fellBack && !m.isStyleLoaded() && /fetch|Failed|NetworkError|style|404|CORS/i.test(msg)) {
          fellBack = true;
          setBasemap("offline");
          m.setStyle(OFFLINE);
        }
      });
      // If the style has not loaded after 8 s (blocked host), switch to the bundled coastline.
      setTimeout(() => { if (!cancelled && !m.isStyleLoaded() && !fellBack) { fellBack = true; setBasemap("offline"); m.setStyle(OFFLINE); } }, 8000);

      const addLayers = () => {
        if (!m.getSource("traffic")) {
          m.addSource("traffic", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "traffic", type: "circle", source: "traffic", paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.2, 10, 5],
            "circle-color": ["match", ["get", "kind"], "yacht", "#2f9fa3", "#8796a0"],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1, "circle-opacity": 0.9 } });
        }
        if (!m.getSource("trails")) {
          m.addSource("trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "trails", type: "line", source: "trails", paint: { "line-color": "#0b6e73", "line-width": 2, "line-dasharray": [2, 1.5], "line-opacity": 0.75 } });
        }
        if (!m.getSource("track")) {
          m.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "track", type: "line", source: "track", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#c9902a", "line-width": 3.5 } });
          m.addSource("signals", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "signals", type: "circle", source: "signals", paint: {
            "circle-radius": 8, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5,
            "circle-stroke-color": ["match", ["get", "source"], "ais", "#c9902a", "sar", "#c2453f", "#0b6e73"] } });
        }
        if (!m.getSource("marinas")) {
          m.addSource("marinas", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({ id: "marinas", type: "circle", source: "marinas", paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 12, 9], "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": "#9a6f14", "circle-stroke-width": 2 } });
        }
        loadMarinas(); refresh();
      };
      m.on("style.load", addLayers);

      m.on("click", "traffic", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string | number | null>;
        new ml.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat(e.lngLat)
          .setHTML(`<b>${esc(String(p.name || "Unnamed vessel"))}</b><br><span class="mono">MMSI ${p.mmsi}</span><br>${p.kind === "yacht" ? "Yacht" : "Vessel"}${p.length_m ? ` · ${p.length_m} m` : ""}${p.sog != null ? ` · ${Number(p.sog).toFixed(1)} kn` : ""}<br><small>Public AIS · ${ago(Number(p.age_s))}</small>`)
          .addTo(m);
      });
      m.on("mouseenter", "traffic", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "traffic", () => (m.getCanvas().style.cursor = ""));

      async function loadMarinas() {
        try {
          const ms: Marina[] = await api("/marinas");
          (m.getSource("marinas") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
            features: ms.map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x.lon, x.lat] }, properties: { name: x.name } })) });
        } catch { /* map still works without marinas */ }
      }

      let first = true;
      async function refresh() {
        try {
          const fleet: Fleet = await api("/live/fleet?trail_minutes=180");
          if (onlyRef.current) fleet.features = fleet.features.filter((f) => onlyRef.current!.includes(f.properties.id));
          const seen = new Set<string>();
          for (const f of fleet.features) {
            const p = f.properties; seen.add(p.id);
            const to = f.geometry.coordinates;
            let rec = markers.current.get(p.id);
            if (!rec) {
              const el = yachtEl(p.name, () => { setSel(p); onSelect?.(p.id); m.flyTo({ center: to, zoom: Math.max(m.getZoom(), 11), speed: reduce ? 3 : 1.1 }); });
              const mk = new ml.Marker({ element: el, rotationAlignment: "map" }).setLngLat(to).addTo(m);
              rec = { m: mk, from: to, to, t0: performance.now() };
              markers.current.set(p.id, rec);
            } else {
              rec.from = [rec.m.getLngLat().lng, rec.m.getLngLat().lat]; rec.to = to; rec.t0 = performance.now();
            }
            const hull = rec.m.getElement().querySelector<SVGElement>(".ym-hull");
            if (hull) hull.style.transform = `rotate(${p.cog ?? 0}deg)`;
            rec.m.getElement().classList.toggle("stale", p.age_s > 3600);
            rec.m.getElement().classList.toggle("focus", p.id === focusRef.current);
          }
          for (const [id, rec] of markers.current) if (!seen.has(id)) { rec.m.remove(); markers.current.delete(id); }
          (m.getSource("trails") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
            features: fleet.features.filter((f) => f.properties.trail && f.properties.trail.length > 1)
              .map((f) => ({ type: "Feature", geometry: { type: "LineString", coordinates: f.properties.trail! }, properties: { id: f.properties.id } })) });
          let traffic = 0;
          if (showTraffic) {
            const b = m.getBounds();
            const t = await api(`/live/vessels?kind=yachts&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => Math.max(-180, Math.min(180, x)).toFixed(3)).join(",")}`);
            t.features = t.features.filter((x: { properties: { kind: string } }) => x.properties.kind !== "fleet");
            traffic = t.features.length;
            (m.getSource("traffic") as GeoJSONSource | undefined)?.setData(t);
          }
          setCounts({ fleet: fleet.features.length, traffic });
          if (first) {
            first = false;
            const target = focusRef.current && fleet.features.find((f) => f.properties.id === focusRef.current);
            if (target) m.jumpTo({ center: target.geometry.coordinates, zoom: 11 });
            else if (!initial && fleet.features.length) {
              const lons = fleet.features.map((f) => f.geometry.coordinates[0]), lats = fleet.features.map((f) => f.geometry.coordinates[1]);
              m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 6, duration: 0 });
            }
          }
        } catch { /* keep the last good frame; next tick retries */ }
        try { setStatus(await api("/live/status")); } catch { /* status chip shows unknown */ }
      }

      // Glide markers from their previous fix to the new one.
      const animate = (now: number) => {
        for (const rec of markers.current.values()) {
          const u = reduce ? 1 : Math.min(1, (now - rec.t0) / 1800);
          const e = u * u * (3 - 2 * u);
          rec.m.setLngLat([rec.from[0] + (rec.to[0] - rec.from[0]) * e, rec.from[1] + (rec.to[1] - rec.from[1]) * e]);
        }
        raf = requestAnimationFrame(animate);
      };
      raf = requestAnimationFrame(animate);
      timers.push(setInterval(refresh, 10_000));
      let mv: ReturnType<typeof setTimeout>;
      m.on("moveend", () => { clearTimeout(mv); mv = setTimeout(refresh, 400); });
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearInterval);
      markers.current.forEach((r) => r.m.remove());
      markers.current.clear();
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- follow the focused yacht ----------
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    markers.current.forEach((r, id) => r.m.getElement().classList.toggle("focus", id === focus));
    const rec = markers.current.get(focus);
    if (rec) m.flyTo({ center: rec.to, zoom: Math.max(m.getZoom(), 10.5), speed: 1.2 });
  }, [focus]);

  // ---------- extra layers from the page (verified track, signals) ----------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      (m.getSource("track") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
        features: track && track.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: track }, properties: {} }] : [] });
      (m.getSource("signals") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
        features: (signals ?? []).filter((s) => s.source !== "gps").map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { source: s.source } })) });
    };
    if (m.isStyleLoaded()) apply(); else m.once("idle", apply);
  }, [track, signals]);

  const live = status?.enabled && status.status === "live";
  return (
    <div className="livemap" style={{ height }}>
      <div ref={box} className="livemap-canvas" />
      <div className="livemap-chip" role="status">
        <span className={`dot ${live ? "on" : ""}`} aria-hidden="true" />
        <span>
          <b>{counts.fleet}</b> GYT yachts
          {showTraffic && <> · <b>{counts.traffic}</b> yachts on public AIS</>}
        </span>
        <span className="small muted">
          {status?.enabled ? (live ? `Live · ${status.provider}` : `AIS ${status.status}`) : "Public AIS off"}
          {basemap === "offline" && " · offline basemap"}
        </span>
      </div>
      {sel && (
        <div className="livemap-card">
          <button className="sm" onClick={() => setSel(null)} aria-label="Close">×</button>
          <span className="eyebrow">{sel.id}</span>
          <b>{sel.name}</b>
          <span className="small">{sel.loa_m} m · home {sel.home}</span>
          <span className="small">{sel.source === "gps" ? "Signed GPS" : "AIS"} · {ago(sel.age_s)}{sel.sog != null ? ` · ${sel.sog.toFixed(1)} kn` : ""}</span>
          <span className="row" style={{ gap: 6 }}>
            <a className="btn sm primary" href={`/track?yacht=${sel.id}`}>Track &amp; verify</a>
            <a className="btn sm" href={`/yachts/${sel.id}`}>Passport</a>
          </span>
        </div>
      )}
    </div>
  );
}
