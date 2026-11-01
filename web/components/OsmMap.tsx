"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { Circle, LayerGroup, Map as LMap, Marker, Polyline } from "leaflet";

/*
  Yacht locations on an OpenStreetMap map (Leaflet + the standard OSM tiles).
  Data: /live/fleet, which gives each verified yacht's latest position from the best source it has:
    gps     signed onboard GPS hardware
    device  a signed-in owner or crew member's phone or laptop ("Track from this device")
    ais     public AIS
  OSM's own tile servers are free for light use with attribution. For heavy traffic, point
  NEXT_PUBLIC_OSM_TILES at another OpenStreetMap tile host (or your own).
*/

const TILES = process.env.NEXT_PUBLIC_OSM_TILES ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export type FleetYacht = {
  id: string; name: string; loa_m: number; home: string; source: "gps" | "device" | "ais"; observed_at: string;
  age_s: number; sog: number | null; cog: number | null; accuracy_m: number | null; good: boolean;
  trail: number[][] | null; lat: number; lon: number;
};

export const SOURCE: Record<string, { label: string; color: string }> = {
  gps: { label: "Hardware GPS", color: "#c9902a" },
  device: { label: "Phone or laptop", color: "#1f8a8a" },
  ais: { label: "Public AIS", color: "#5b6b82" },
};

export const ago = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function loadFleet(): Promise<FleetYacht[]> {
  const r = await fetch("/api/gyt/live/fleet?trail_minutes=180", { cache: "no-store" });
  if (!r.ok) throw new Error(`Map data unavailable (${r.status})`);
  const g = await r.json();
  return g.features.map((f: { geometry: { coordinates: [number, number] }; properties: Omit<FleetYacht, "lat" | "lon"> }) => ({
    ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
  }));
}

type Me = { lat: number; lon: number; accuracy: number } | null;

export type OsmMapProps = {
  height?: number | string;
  only?: string[];                         // show just these yachts
  focus?: string | null;                   // yacht to centre on and open
  me?: Me;                                 // this device's own location (device tracker page)
  refreshSeconds?: number;
  onData?: (ys: FleetYacht[]) => void;
  onSelect?: (id: string) => void;
};

function icon(L: typeof import("leaflet"), y: FleetYacht, selected: boolean) {
  const c = SOURCE[y.source]?.color ?? "#5b6b82";
  const rot = y.cog ?? 0;
  const stale = y.age_s > 6 * 3600;
  return L.divIcon({
    className: "osm-y",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
    html: `<span class="osm-y-dot${selected ? " sel" : ""}${stale ? " stale" : ""}" style="--c:${c}">
             <svg viewBox="0 0 24 24" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M12 2 L17 15 Q12 22 7 15 Z"/></svg>
           </span><span class="osm-y-name">${esc(y.name)}</span>`,
  });
}

function popup(y: FleetYacht) {
  const src = SOURCE[y.source] ?? { label: y.source, color: "#888" };
  const acc = y.source === "device" && y.accuracy_m != null ? ` · ±${Math.round(y.accuracy_m)} m` : "";
  const sog = y.sog != null ? `${y.sog.toFixed(1)} kn` : "—";
  return `<div class="osm-pop">
      <b>${esc(y.name)}</b>
      <div class="osm-pop-src"><i style="background:${src.color}"></i>${src.label}${acc}${y.source === "device" && !y.good ? " · approximate" : ""}</div>
      <div class="osm-pop-kv"><span>Seen</span><span>${ago(y.age_s)}</span></div>
      <div class="osm-pop-kv"><span>Speed</span><span>${sog}</span></div>
      <div class="osm-pop-kv"><span>Position</span><span class="mono">${y.lat.toFixed(4)}, ${y.lon.toFixed(4)}</span></div>
      <div class="osm-pop-kv"><span>Home</span><span>${esc(y.home)}</span></div>
      <div class="osm-pop-links"><a href="/yachts/${encodeURIComponent(y.id)}">Passport</a><a href="/track?yacht=${encodeURIComponent(y.id)}">Track &amp; verify</a></div>
    </div>`;
}

export default function OsmMap({ height = 520, only, focus = null, me = null, refreshSeconds = 15, onData, onSelect }: OsmMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const Lref = useRef<typeof import("leaflet") | null>(null);
  const layers = useRef<{ markers: Map<string, Marker>; trails: LayerGroup | null; acc: LayerGroup | null; me: { m: Marker; c: Circle } | null }>({
    markers: new Map(), trails: null, acc: null, me: null,
  });
  const fitted = useRef(false);
  const data = useRef<FleetYacht[]>([]);
  const [err, setErr] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const onlyKey = only?.join(",") ?? "";
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const cb = useRef({ onData, onSelect });
  cb.current = { onData, onSelect };

  // create the map once
  useEffect(() => {
    let dead = false;
    (async () => {
      const L = await import("leaflet");
      if (dead || !box.current || map.current) return;
      Lref.current = L;
      const m = L.map(box.current, { zoomControl: true, worldCopyJump: true, scrollWheelZoom: false }).setView([30, 20], 3);
      L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(m);
      L.control.scale({ imperial: false, metric: true, position: "bottomleft" }).addTo(m);
      // wheel zoom only after the map is clicked, so the page still scrolls
      m.on("click", () => m.scrollWheelZoom.enable());
      m.on("mouseout", () => m.scrollWheelZoom.disable());
      layers.current.trails = L.layerGroup().addTo(m);
      layers.current.acc = L.layerGroup().addTo(m);
      map.current = m;
      refresh();
    })();
    return () => {
      dead = true;
      map.current?.remove();
      map.current = null;
      layers.current = { markers: new Map(), trails: null, acc: null, me: null };
      fitted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const L = Lref.current, m = map.current;
    if (!L || !m) return;
    const want = only ? data.current.filter((y) => only.includes(y.id)) : data.current;
    const seen = new Set<string>();
    layers.current.trails!.clearLayers();
    layers.current.acc!.clearLayers();
    for (const y of want) {
      seen.add(y.id);
      const sel = focusRef.current === y.id;
      let mk = layers.current.markers.get(y.id);
      if (!mk) {
        mk = L.marker([y.lat, y.lon], { icon: icon(L, y, sel), title: y.name, keyboard: true, riseOnHover: true }).addTo(m);
        mk.on("click", () => cb.current.onSelect?.(y.id));
        layers.current.markers.set(y.id, mk);
      } else {
        mk.setLatLng([y.lat, y.lon]);
        mk.setIcon(icon(L, y, sel));
      }
      mk.bindPopup(popup(y), { maxWidth: 260 });
      const c = SOURCE[y.source]?.color ?? "#5b6b82";
      if (y.trail && y.trail.length > 1) {
        (L.polyline(y.trail.map(([lon, lat]) => [lat, lon]) as [number, number][], { color: c, weight: 3, opacity: 0.7 }) as Polyline)
          .addTo(layers.current.trails!);
      }
      if (y.source === "device" && y.accuracy_m && y.accuracy_m > 15) {
        L.circle([y.lat, y.lon], { radius: y.accuracy_m, color: c, weight: 1, fillOpacity: 0.08 }).addTo(layers.current.acc!);
      }
    }
    for (const [id, mk] of layers.current.markers) if (!seen.has(id)) { mk.remove(); layers.current.markers.delete(id); }
    setCount(want.length);

    const f = focusRef.current && layers.current.markers.get(focusRef.current);
    if (f && !fitted.current) {
      m.setView(f.getLatLng(), 12);
      f.openPopup();
      fitted.current = true;
    } else if (!fitted.current && want.length) {
      const b = L.latLngBounds(want.map((y) => [y.lat, y.lon] as [number, number]));
      if (me) b.extend([me.lat, me.lon]);
      m.fitBounds(b.pad(0.25), { maxZoom: 11 });
      fitted.current = true;
    }
  }

  async function refresh() {
    try {
      data.current = await loadFleet();
      setErr("");
      cb.current.onData?.(data.current);
      draw();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // poll
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, refreshSeconds * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSeconds]);

  // filter or focus changed
  useEffect(() => {
    fitted.current = false;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyKey, focus]);

  // this device's own position
  useEffect(() => {
    const L = Lref.current, m = map.current;
    if (!L || !m) return;
    if (!me) { layers.current.me?.m.remove(); layers.current.me?.c.remove(); layers.current.me = null; return; }
    if (!layers.current.me) {
      const c = L.circle([me.lat, me.lon], { radius: me.accuracy, color: "#2b6cb0", weight: 1, fillOpacity: 0.12 }).addTo(m);
      const mk = L.marker([me.lat, me.lon], {
        icon: L.divIcon({ className: "osm-me", iconSize: [18, 18], iconAnchor: [9, 9], html: '<span class="osm-me-dot"></span>' }),
        title: "This device", zIndexOffset: 1000,
      }).addTo(m).bindTooltip("This device");
      layers.current.me = { m: mk, c };
      m.setView([me.lat, me.lon], Math.max(m.getZoom(), 14));
    } else {
      layers.current.me.m.setLatLng([me.lat, me.lon]);
      layers.current.me.c.setLatLng([me.lat, me.lon]).setRadius(me.accuracy);
    }
  }, [me]);

  function fitAll() {
    const L = Lref.current, m = map.current;
    if (!L || !m) return;
    const pts = [...layers.current.markers.values()].map((mk) => mk.getLatLng());
    if (me) pts.push(L.latLng(me.lat, me.lon));
    if (pts.length) m.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 12 });
  }

  return (
    <div className="osm-wrap" style={{ height }}>
      <div ref={box} className="osm-canvas" role="region" aria-label="OpenStreetMap of yacht locations" />
      <div className="osm-legend small" aria-label="Map legend">
        {Object.entries(SOURCE).map(([k, s]) => <span key={k}><i style={{ background: s.color }} />{s.label}</span>)}
        {me && <span><i style={{ background: "#2b6cb0" }} />This device</span>}
      </div>
      <div className="osm-tools">
        <button type="button" className="sm" onClick={fitAll}>Show all</button>
        {count !== null && <span className="small">{count} {count === 1 ? "yacht" : "yachts"}</span>}
      </div>
      {err && <p className="osm-err small" role="status">{err}</p>}
    </div>
  );
}
