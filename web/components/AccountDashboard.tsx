"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import LiveMap from "./LiveMap";
import { CountUp } from "./Kinetic";
import { CATS, ICON, ago, category, label, type Cat } from "@/lib/activity";

type DY = {
  id: string; name: string; flag: string; loa_m: string; marina_name: string; tokenized: boolean; following: boolean;
  units: number; mode: "use" | "earn" | null; unit_price_usd: number | null; holding_value_usd: number; share_pct: number;
  pos_source: string | null; pos_at: string | null; lat: number | null; lon: number | null; sog_kn: number | null; events_7d: number;
  inspection_status: string; insurance_verified: boolean; owner: boolean; twin_status: string; cover_photo_id: number | null; photo_count: number;
};
type Act = { id: number; yacht_id: string; yacht_name: string; event_type: string; observed_at: string; leaf: string; anchor_id: number | null };
type Bk = { ref: string; kind: string; yacht_name: string; marina_name: string; arrive: string; depart: string; amount_usd: string; status: string };
type Profile = { name: string; email: string; status: string; phone: string | null; country: string | null; interests: string[]; investor_id: string | null; wallet_address: string | null; kyc_status: string | null };
type Dash = { profile: Profile; yachts: DY[]; activity: Act[]; bookings: Bk[]; summary: { owned: number; following: number; holdings: number; units: number; portfolio_usd: number; upcoming_bookings: number; events_7d: number } };

const usd = (n: number | string | null | undefined) => `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
const greet = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const call = async (p: string, init?: RequestInit) => {
  const r = await fetch(`/api/gyt${p}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `Request failed (${r.status})`);
  return r.status === 204 ? null : r.json();
};

export default function AccountDashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const [cat, setCat] = useState<Cat | "all">("all");
  const [focus, setFocus] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try { setD(await call("/me/dashboard")); setErr(""); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);

  const acts = useMemo(() => (d?.activity ?? []).filter((a) => cat === "all" || category(a.event_type) === cat), [d, cat]);
  const byDay = useMemo(() => {
    const m = new Map<string, Act[]>();
    for (const a of acts.slice(0, 40)) {
      const k = new Date(a.observed_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()];
  }, [acts]);

  async function unfollow(y: DY) {
    await call(`/me/follows/${y.id}`, { method: "DELETE" }); setToast(`Stopped following ${y.name}`); load();
  }
  async function setMode(y: DY, mode: "use" | "earn") {
    try { await call(`/investors/${d!.profile.investor_id}/holdings/${y.id}/mode`, { method: "PUT", body: JSON.stringify({ mode }) }); setToast(`${y.name}: ${mode === "use" ? "using credits" : "earning"} this year`); load(); }
    catch (e) { setToast((e as Error).message); }
  }

  if (err && !d) return <main className="wrap page"><p className="err">{err}</p></main>;
  if (!d) return <main className="wrap page"><div className="skel" style={{ height: 120 }} /><div className="skel" style={{ height: 320 }} /></main>;

  const p = d.profile, s = d.summary;
  const owned = d.yachts.filter((y) => y.owner);
  const tasks = [
    { done: s.following > 0, t: "Follow a yacht", href: "/yachts" },
    ...(p.interests.includes("own") || owned.length ? [
      { done: owned.length > 0, t: "List your yacht", href: "/onboard" },
      ...(owned.length ? [{ done: owned.every((y) => y.photo_count > 0), t: "Add photos of your yacht", href: `/yachts/${(owned.find((y) => !y.photo_count) ?? owned[0]).id}#photos` }] : []),
    ] : []),
    { done: !!p.phone, t: "Add a mobile number for alerts", href: "/account/settings#profile" },
    { done: !!p.country, t: "Set your country", href: "/account/settings#profile" },
    ...(p.interests.includes("invest") ? [
      { done: !!p.investor_id, t: "Start investor eligibility", href: "/earn" },
      { done: !!p.wallet_address, t: "Add your wallet address", href: "/account/settings#investor" },
    ] : []),
  ];
  const left = tasks.filter((t) => !t.done);
  return (
    <main className="wrap page acct">
      <div className="acct-head">
        <div>
          <div className="eyebrow">My GYT</div>
          <h1>{greet()}, {p.name.split(" ")[0]}</h1>
          <p className="muted small" style={{ margin: 0 }}>Everything about the yachts you follow and own, updated every 30 seconds.</p>
        </div>
        <div className="row"><Link className="btn" href="/account/settings">Settings</Link><Link className="btn primary" href="/yachts">Follow more yachts</Link></div>
      </div>

      {p.status === "pending" && (
        <div className="banner warn row" style={{ justifyContent: "space-between" }}>
          <span><b>Approval pending.</b> You can browse, follow and track now. Bookings and investments open once an admin approves your account.</span>
          <button className="sm" onClick={async () => { await fetch("/api/auth/refresh", { method: "POST" }); load(); }}>Check status</button>
        </div>
      )}

      <div className="kpis">
        <div className="kpi2"><span>Following</span><b><CountUp value={s.following} /></b><small>yachts</small></div>
        <div className="kpi2"><span>Units held</span><b><CountUp value={s.units} /></b><small>across {s.holdings} yacht{s.holdings === 1 ? "" : "s"}</small></div>
        <div className="kpi2"><span>Indicative value</span><b>$<CountUp value={Math.round(s.portfolio_usd)} /></b><small>at latest valuations</small></div>
        <div className="kpi2"><span>Activity</span><b><CountUp value={s.events_7d} /></b><small>records in 7 days</small></div>
      </div>

      {left.length > 0 && (
        <div className="setup panel">
          <div className="row" style={{ justifyContent: "space-between" }}><b>Finish setting up</b><span className="small muted">{tasks.length - left.length} of {tasks.length} done</span></div>
          <div className="setup-bar"><i style={{ width: `${((tasks.length - left.length) / tasks.length) * 100}%` }} /></div>
          <div className="setup-items">{tasks.map((t) => <Link key={t.t} href={t.href} className={t.done ? "done" : ""}><span>{t.done ? "✓" : "○"}</span>{t.t}</Link>)}</div>
        </div>
      )}

      <section className="acct-grid">
        <div className="panel">
          <header><h3>My yachts</h3><span className="small muted">{d.yachts.length} total</span></header>
          {d.yachts.length === 0 ? (
            <div className="empty"><b>You are not following any yachts yet.</b><p className="small muted">Open any yacht&apos;s passport and press Follow, or pick a few now.</p><Link className="btn primary" href="/yachts">Explore yachts</Link></div>
          ) : (
            <div className="myyachts">
              {d.yachts.map((y) => {
                const live = y.pos_at && Date.now() - new Date(y.pos_at).getTime() < 3600_000;
                const moving = (y.sog_kn ?? 0) > 0.5;
                return (
                  <article key={y.id} className={`my ${focus === y.id ? "on" : ""}`} onMouseEnter={() => setFocus(y.id)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={y.cover_photo_id ? `/api/gyt/photos/${y.cover_photo_id}` : `/media/yachts/${y.id}.jpg`} alt="" onError={(e) => { (e.target as HTMLImageElement).src = "/media/yachts/default.jpg"; }} />
                    <div className="my-b">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <b>{y.name}</b>
                        <span className={`pill ${live ? "ok" : ""}`}>{live ? <><span className="dot on" aria-hidden="true" /> {moving ? `Underway ${y.sog_kn!.toFixed(1)} kn` : "At berth"}</> : "No recent fix"}</span>
                      </div>
                      <span className="small muted">{Number(y.loa_m)} m · {y.marina_name}{y.pos_at ? ` · ${y.pos_source?.toUpperCase()} ${ago(y.pos_at)}` : ""}</span>
                      <span className="row small" style={{ gap: 6 }}>
                        {y.owner && <span className="pill ok">Your yacht{y.twin_status !== "minted" ? ` · ${y.twin_status === "pending" ? "in verification" : y.twin_status}` : ""}</span>}
                        {y.following && <span className="pill">Following</span>}
                        {y.units > 0 && <span className="pill ok">{y.units.toLocaleString()} units · {usd(y.holding_value_usd)}</span>}
                        {y.unit_price_usd && <span className="pill">1 unit ≈ {usd(y.unit_price_usd)}</span>}
                        {y.inspection_status !== "VALID" && <span className="pill warn">Inspection {y.inspection_status.toLowerCase().replace("_", " ")}</span>}
                        {!y.insurance_verified && <span className="pill crit">Insurance pending</span>}
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        <Link className="btn sm primary" href={`/track?yacht=${y.id}`}>Track</Link>
                        <Link className="btn sm" href={`/yachts/${y.id}`}>Passport</Link>
                        {y.owner && <Link className="btn sm" href={`/yachts/${y.id}#photos`}>{y.photo_count ? `Photos (${y.photo_count})` : "＋ Add photos"}</Link>}
                        {y.following && <button className="sm ghost" onClick={() => unfollow(y)}>Unfollow</button>}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <div className="panel">
          <header><h3>Where they are</h3><span className="small muted">Live · signed GPS and AIS</span></header>
          <LiveMap height={420} only={d.yachts.map((y) => y.id)} focus={focus} showTraffic={false} />
        </div>
      </section>

      <section className="panel" id="activity">
        <header><h3>Activity</h3><span className="small muted">Every item is a hashed record. Click a hash to verify it.</span></header>
        <div className="chips" role="group" aria-label="Filter activity">
          {CATS.map(([k, l]) => {
            const n = k === "all" ? d.activity.length : d.activity.filter((a) => category(a.event_type) === k).length;
            return <button key={k} className="chip" aria-pressed={cat === k} onClick={() => setCat(k)}>{l} <span>{n}</span></button>;
          })}
        </div>
        {byDay.length === 0 ? <p className="muted small">Nothing here yet. Records appear as your yachts report in.</p> : byDay.map(([day, items]) => (
          <div key={day} className="feed-day">
            <div className="feed-date">{day}</div>
            <ol className="feed">
              {items.map((a) => {
                const c = category(a.event_type);
                return (
                  <li key={a.id} className={`fi ${c}`}>
                    <span className="fi-ic" aria-hidden="true">{ICON[c]}</span>
                    <div className="fi-b">
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span><b>{label(a.event_type)}</b> <span className="muted">· {a.yacht_name}</span></span>
                        <span className="small muted" title={new Date(a.observed_at).toLocaleString()}>{ago(a.observed_at)}</span>
                      </div>
                      <div className="row small" style={{ gap: 8 }}>
                        <Link className="mono hashlink" href={`/verify?hash=${a.leaf}`}>{a.leaf.slice(0, 10)}…{a.leaf.slice(-6)}</Link>
                        <span className={`pill ${a.anchor_id ? "ok" : "warn"}`}>{a.anchor_id ? `Anchored #${a.anchor_id}` : "Pending anchor"}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </section>

      <section className="acct-grid">
        <div className="panel">
          <header><h3>Holdings</h3><Link className="small" href="/earn">Use or Earn →</Link></header>
          {d.yachts.some((y) => y.units) ? (
            <div className="tbl"><table>
              <thead><tr><th>Yacht</th><th className="r">Units</th><th className="r">Share</th><th className="r">1 unit</th><th className="r">Value</th><th>This year</th></tr></thead>
              <tbody>{d.yachts.filter((y) => y.units).map((y) => (
                <tr key={y.id}>
                  <td><Link href={`/yachts/${y.id}#units`}>{y.name}</Link></td>
                  <td className="r">{y.units.toLocaleString()}</td><td className="r">{y.share_pct.toFixed(3)}%</td>
                  <td className="r">{usd(y.unit_price_usd)}</td><td className="r"><b>{usd(y.holding_value_usd)}</b></td>
                  <td><span className="seg" role="group" aria-label={`${y.name} mode`}>
                    <button aria-pressed={y.mode === "use"} onClick={() => setMode(y, "use")}>Use</button>
                    <button aria-pressed={y.mode === "earn"} onClick={() => setMode(y, "earn")}>Earn</button></span></td>
                </tr>))}</tbody>
            </table></div>
          ) : (
            <div className="empty"><b>No units yet.</b><p className="small muted">Units are offered through licensed partners to eligible investors. Each yacht&apos;s passport shows what one unit is worth and who holds them.</p>
              <Link className="btn" href="/how-it-works">How owning units works</Link></div>
          )}
        </div>
        <div className="panel">
          <header><h3>Bookings</h3><span className="small muted">{s.upcoming_bookings} upcoming</span></header>
          {d.bookings.length ? d.bookings.map((b) => (
            <div className="kv" key={b.ref}><span><b className="mono">{b.ref}</b> · {b.yacht_name}<br /><span className="small muted">{b.marina_name} · {b.arrive} → {b.depart}</span></span>
              <span>{usd(b.amount_usd)}<br /><span className={`pill ${b.status === "released" ? "ok" : b.status === "escrowed" ? "warn" : ""}`}>{b.status}</span></span></div>
          )) : <p className="muted small">No bookings yet. Find a berth from any yacht&apos;s passport.</p>}
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
