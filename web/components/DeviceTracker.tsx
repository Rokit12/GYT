"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import OsmMap, { ago } from "@/components/OsmMap";

/*
  Track from this device: the phone or laptop's own location becomes the yacht's position while
  this page is open and sharing. No tracking hardware needed.

  - Location comes from the browser (navigator.geolocation, high accuracy). It needs HTTPS.
  - One fix is sent every `min_interval_s` seconds (the newest reading wins).
  - With no signal, fixes wait in this browser and are sent together when the connection returns.
  - The screen is kept awake where the browser allows it, because phones pause location for
    web pages when the screen locks.
*/

type Trackable = {
  id: string; name: string; role: "owner" | "crew" | "admin"; twin_status: string;
  session_id: string | null; started_at: string | null; fixes: number | null;
  last_position: { lat: number; lon: number; at: string; source: string; accuracy_m: number | null } | null;
};
type Settings = { enabled: boolean; min_interval_s: number; max_accuracy_m: number; good_accuracy_m: number };
type Crew = { id: number; name: string; email: string; role: string };
type Fix = { lat: number; lon: number; accuracy_m: number; observed_at: string; speed_mps?: number; heading_deg?: number };
type State = "idle" | "starting" | "waiting" | "sharing" | "offline" | "denied" | "error";

const QKEY = (sid: string) => `gyt.devq.${sid}`;
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

function guessLabel() {
  if (typeof navigator === "undefined") return "Phone or laptop";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  return "Laptop";
}

const STATE_TEXT: Record<State, [string, string]> = {
  idle: ["Not sharing", ""],
  starting: ["Starting…", "warn"],
  waiting: ["Waiting for a location fix…", "warn"],
  sharing: ["Sharing location", "ok"],
  offline: ["No connection: saving fixes on this device", "warn"],
  denied: ["Location permission is off", "crit"],
  error: ["Something went wrong", "crit"],
};

export default function DeviceTracker() {
  const [list, setList] = useState<Trackable[] | null>(null);
  const [cfg, setCfg] = useState<Settings | null>(null);
  const [yid, setYid] = useState("");
  const [label, setLabel] = useState("");
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");
  const [me, setMe] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [sent, setSent] = useState(0);
  const [queued, setQueued] = useState(0);
  const [lastSent, setLastSent] = useState<number | null>(null);
  const [lastNote, setLastNote] = useState("");
  const [awake, setAwake] = useState<boolean | null>(null);
  const [, tick] = useState(0);
  const [loadErr, setLoadErr] = useState("");

  const sid = useRef<string | null>(null);
  const watch = useRef<number | null>(null);
  const latest = useRef<Fix | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lock = useRef<WakeLockSentinel | null>(null);
  const lastSentRef = useRef<number | null>(null);
  const lastReading = useRef(0);
  const lastFix = useRef<Fix | null>(null);
  const yidRef = useRef(yid);
  yidRef.current = yid;

  const load = useCallback(async () => {
    try {
      const r = await call<{ yachts: Trackable[]; settings: Settings }>("/me/trackable");
      setList(r.yachts);
      setCfg(r.settings);
      setYid((cur) => cur || r.yachts.find((y) => y.session_id)?.id || r.yachts[0]?.id || "");
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message);
      setList([]);
    }
  }, []);

  useEffect(() => {
    load();
    setLabel(store.get("gyt.devlabel", "") || guessLabel());
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [load]);

  const yacht = list?.find((y) => y.id === yid) ?? null;
  const sharing = state !== "idle" && state !== "denied" && state !== "error";

  // ------------------------------------------------------------ sending

  const flushQueue = useCallback(async () => {
    const s = sid.current;
    if (!s) return;
    const q = store.get<Fix[]>(QKEY(s), []);
    if (!q.length) return;
    try {
      const r = await call<{ accepted: number }>(`/yachts/${yidRef.current}/device/fixes`, {
        method: "POST", body: JSON.stringify({ session_id: s, fixes: q.slice(0, 500) }),
      });
      const rest = q.slice(500);
      rest.length ? store.set(QKEY(s), rest) : store.del(QKEY(s));
      setQueued(rest.length);
      setSent((n) => n + r.accepted);
      if (r.accepted) setLastSent(Date.now());
    } catch { /* still offline; try again next round */ }
  }, []);

  const sendLatest = useCallback(async () => {
    const s = sid.current, f = latest.current;
    if (!s) return;
    if (!f) {
      // Browsers only report a new reading when the device moves. At anchor the watch stays quiet,
      // so once a minute re-send the last reading, stamped now, to show the yacht is still there.
      // Only while the watch is healthy (a location error clears lastFix).
      const lf = lastFix.current;
      if (lf && Date.now() - lastReading.current > 60_000 && watch.current !== null) {
        lastReading.current = Date.now();
        latest.current = { ...lf, observed_at: new Date().toISOString() };
        return sendLatest();
      }
      return;
    }
    latest.current = null;
    try {
      if (!navigator.onLine) throw new Error("offline");
      const r = await call<{ accepted: boolean; good?: boolean; reason?: string; code?: string; flags?: string[] }>(
        `/yachts/${yidRef.current}/device/fix`, { method: "POST", body: JSON.stringify({ session_id: s, ...f }) },
      );
      if (r.accepted) {
        setSent((n) => n + 1);
        setLastSent(Date.now());
        setLastNote(r.good ? "" : r.flags?.length ? "Stored, but flagged as an unusual jump." : "Stored as approximate (accuracy is low).");
        setState("sharing");
      } else if (r.code !== "THROTTLED" && r.code !== "OUT_OF_ORDER") {
        setLastNote(r.reason ?? "Fix not accepted.");
      }
      flushQueue();
    } catch (e) {
      const m = (e as Error).message;
      if (/ended|Start sharing again|share its location|not found/i.test(m)) {
        stopLocal();
        setState("error");
        setMsg(m);
        return;
      }
      // network trouble: keep it for later
      const q = store.get<Fix[]>(QKEY(s), []);
      q.push(f);
      store.set(QKEY(s), q.slice(-5000));
      setQueued(Math.min(q.length, 5000));
      setState("offline");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushQueue]);

  async function keepAwake() {
    try {
      if ("wakeLock" in navigator) {
        lock.current = await navigator.wakeLock.request("screen");
        setAwake(true);
        lock.current.addEventListener("release", () => setAwake(false));
      } else setAwake(false);
    } catch { setAwake(false); }
  }

  useEffect(() => {
    const vis2 = () => { if (document.visibilityState === "visible" && sid.current) { keepAwake(); sendLatest(); } };
    const online = () => { if (sid.current) { flushQueue(); setState((s) => (s === "offline" ? "sharing" : s)); } };
    document.addEventListener("visibilitychange", vis2);
    window.addEventListener("online", online);
    const warn = (e: BeforeUnloadEvent) => { if (sid.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", vis2);
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", warn);
    };
  }, [flushQueue, sendLatest]);

  useEffect(() => () => stopLocal(), []);

  function stopLocal() {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    lock.current?.release().catch(() => {});
    lock.current = null;
    sid.current = null;
    lastFix.current = null;
    latest.current = null;
  }

  // ------------------------------------------------------------ start / stop

  async function start(resume?: string) {
    if (!yacht || !cfg) return;
    if (!("geolocation" in navigator)) { setState("error"); setMsg("This browser cannot share location."); return; }
    if (!window.isSecureContext) { setState("error"); setMsg("Location needs a secure (https://) connection."); return; }
    setMsg("");
    setLastNote("");
    setState("starting");
    store.set("gyt.devlabel", label);
    try {
      const s = resume ?? (await call<{ session_id: string }>(`/yachts/${yacht.id}/device/start`, {
        method: "POST", body: JSON.stringify({ label }),
      })).session_id;
      sid.current = s;
      setQueued(store.get<Fix[]>(QKEY(s), []).length);
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
      return;
    }
    setState("waiting");
    keepAwake();
    const onPos = (p: GeolocationPosition) => {
        const f: Fix = {
          lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.max(1, p.coords.accuracy),
          observed_at: new Date(p.timestamp).toISOString(),
          ...(p.coords.speed != null && p.coords.speed >= 0 ? { speed_mps: p.coords.speed } : {}),
          ...(p.coords.heading != null && !Number.isNaN(p.coords.heading) ? { heading_deg: p.coords.heading % 360 } : {}),
        };
        latest.current = f;
        lastFix.current = f;
        lastReading.current = Date.now();
        setMe({ lat: f.lat, lon: f.lon, accuracy: f.accuracy_m });
        if (!lastSentRef.current) { lastSentRef.current = Date.now(); sendLatest(); }
    };
    watch.current = navigator.geolocation.watchPosition(
      onPos,
      (e) => {
        if (e.code === e.PERMISSION_DENIED) {
          setState("denied");
          setMsg("Allow location for this site in your browser or phone settings, then press Start again.");
          stopLocal();
        } else {
          lastFix.current = null;
          setLastNote(e.code === e.TIMEOUT ? "Still looking for a location fix. Move into the open if you can." : "Location is unavailable right now.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
    timer.current = setInterval(sendLatest, Math.max(5, cfg.min_interval_s) * 1000);
    load();
  }
  async function stop() {
    const s = sid.current;
    await flushQueue();
    stopLocal();
    lastSentRef.current = null;
    setState("idle");
    setLastNote("");
    setMsg("");
    setMe(null);
    if (s && yacht) {
      try { await call(`/yachts/${yacht.id}/device/stop`, { method: "POST", body: JSON.stringify({ session_id: s }) }); } catch { /* ended anyway */ }
    }
    load();
  }

  // ------------------------------------------------------------ view

  if (list === null) return <p className="muted">Loading your yachts…</p>;

  if (!list.length) {
    return (
      <div className="panel empty-state">
        <h2>No yacht to track yet</h2>
        <p className="muted">
          You can share location for a yacht you own, or one whose owner added you as crew.
          {loadErr && <> ({loadErr})</>}
        </p>
        <div className="row"><Link className="btn primary" href="/onboard">List your yacht</Link><Link className="btn" href="/map">See the yacht map</Link></div>
      </div>
    );
  }

  const [stText, stTone] = STATE_TEXT[state];
  return (
    <div className="devt">
      <div className="panel devt-ctrl">
        <label className="f">Yacht
          <select value={yid} onChange={(e) => setYid(e.target.value)} disabled={sharing}>
            {list.map((y) => <option key={y.id} value={y.id}>{y.name} ({y.role})</option>)}
          </select>
        </label>
        <label className="f">This device
          <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} disabled={sharing} placeholder="Captain's phone" />
        </label>

        <div className={`devt-status ${stTone}`} role="status" aria-live="polite">
          <span className={`devt-dot ${state === "sharing" ? "live" : ""}`} aria-hidden="true" />
          <div>
            <b>{stText}</b>
            {msg && <div className="small">{msg}</div>}
            {!msg && lastNote && <div className="small">{lastNote}</div>}
          </div>
        </div>

        {!sharing ? (
          <div className="row">
            <button className="btn primary lg" onClick={() => start()} disabled={!cfg?.enabled}>Start sharing location</button>
            {yacht?.session_id && <button className="btn" onClick={() => start(yacht.session_id!)}>Resume last session</button>}
          </div>
        ) : (
          <button className="btn lg danger" onClick={stop}>Stop sharing</button>
        )}

        <dl className="devt-kv">
          <div><dt>Accuracy</dt><dd>{me ? `±${Math.round(me.accuracy)} m` : "—"}{me && cfg && me.accuracy > cfg.good_accuracy_m ? " (approximate)" : ""}</dd></div>
          <div><dt>Sent</dt><dd>{sent} {sent === 1 ? "fix" : "fixes"}</dd></div>
          <div><dt>Last sent</dt><dd>{lastSent ? ago((Date.now() - lastSent) / 1000) : "—"}</dd></div>
          <div><dt>Waiting to send</dt><dd>{queued}</dd></div>
          <div><dt>Screen kept awake</dt><dd>{awake === null ? "—" : awake ? "Yes" : "Not supported: keep the screen on"}</dd></div>
          <div><dt>Interval</dt><dd>every {cfg?.min_interval_s ?? 10} s</dd></div>
        </dl>

        <details className="small devt-help">
          <summary>How this works and what to expect</summary>
          <ul>
            <li>Your device&apos;s location becomes <b>{yacht?.name}</b>&apos;s position on the GYT map while this page is open and sharing.</li>
            <li>Keep this page open, the screen on and the phone charging. Phones pause location for web pages when the screen locks or you switch apps.</li>
            <li>No signal at sea? Fixes are saved on this device and sent when the connection returns.</li>
            <li>Phone positions are tied to your account, not to sealed hardware, so they are labelled <i>Phone or laptop</i>. For an arrival proof, AIS or satellite radar must still agree with them.</li>
            <li>Starting and stopping are recorded as hashed events on the yacht&apos;s timeline.</li>
          </ul>
        </details>
      </div>

      <div className="devt-map">
        <OsmMap height="min(62vh, 560px)" only={yacht ? [yacht.id] : []} me={me} refreshSeconds={20} />
        {yacht?.last_position && (
          <p className="small muted">
            Last recorded position: {yacht.last_position.lat.toFixed(4)}, {yacht.last_position.lon.toFixed(4)} from{" "}
            {yacht.last_position.source === "device" ? "a phone or laptop" : yacht.last_position.source.toUpperCase()},{" "}
            {ago((Date.now() - new Date(yacht.last_position.at).getTime()) / 1000)}.
            {yacht.twin_status !== "minted" && " This yacht shows on the public map once its passport is verified."}
          </p>
        )}
        {yacht && (yacht.role === "owner" || yacht.role === "admin") && <CrewPanel yachtId={yacht.id} />}
      </div>
    </div>
  );
}

function CrewPanel({ yachtId }: { yachtId: string }) {
  const [crew, setCrew] = useState<Crew[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("captain");
  const [err, setErr] = useState("");
  const load = useCallback(() => call<Crew[]>(`/yachts/${yachtId}/crew`).then(setCrew).catch(() => setCrew([])), [yachtId]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await call(`/yachts/${yachtId}/crew`, { method: "POST", body: JSON.stringify({ email, role }) });
      setEmail("");
      load();
    } catch (x) { setErr((x as Error).message); }
  }
  async function remove(id: number) {
    await call(`/yachts/${yachtId}/crew/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  return (
    <div className="panel">
      <header><h3>Crew who can share location</h3></header>
      <p className="small muted">Add your captain or skipper so they can track the yacht from their own phone. If they don&apos;t have a GYT account yet, send them an invite code: they join straight onto this yacht&apos;s crew.</p>
      <InviteBox yachtId={yachtId} />
      <ul className="crew-list">
        {crew.map((c) => (
          <li key={c.id}><span><b>{c.name}</b> <span className="small muted">{c.email} · {c.role}</span></span>
            <button className="sm" onClick={() => remove(c.id)}>Remove</button></li>
        ))}
        {!crew.length && <li className="small muted">No crew added yet.</li>}
      </ul>
      <form className="crew-form" onSubmit={add}>
        <input type="email" required placeholder="captain@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Crew email" />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="captain">Captain</option><option value="crew">Crew</option></select>
        <button className="primary">Add</button>
      </form>
      {err && <p className="err small">{err}</p>}
    </div>
  );
}

function InviteBox({ yachtId }: { yachtId: string }) {
  const [email, setEmail] = useState("");
  const [inv, setInv] = useState<{ code: string; expires_at: string } | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  async function make() {
    setErr(""); setCopied(false);
    try {
      setInv(await call<{ code: string; expires_at: string }>("/invites", { method: "POST", body: JSON.stringify({ role: "captain", yacht_id: yachtId, email: email || null }) }));
    } catch (e) { setErr((e as Error).message); }
  }
  const link = inv ? `${typeof window !== "undefined" ? window.location.origin : ""}/signup?invite=${inv.code}` : "";
  return (
    <div className="invite-box">
      <div className="crew-form">
        <input type="email" placeholder="Their email (optional, locks the code to it)" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Invitee email" />
        <button type="button" onClick={make}>Create invite code</button>
      </div>
      {inv && (
        <p className="small">Code <b className="mono">{inv.code}</b> · valid until {new Date(inv.expires_at).toLocaleDateString()} ·{" "}
          <button type="button" className="sm" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Link copied" : "Copy sign-up link"}</button>
          <br /><span className="mono small muted" style={{ wordBreak: "break-all" }}>{link}</span></p>
      )}
      {err && <p className="err small">{err}</p>}
    </div>
  );
}
