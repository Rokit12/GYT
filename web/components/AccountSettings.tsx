"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import PasswordField, { passwordChecks } from "./PasswordField";
import { COUNTRIES } from "@/lib/countries";

type P = {
  id: number; email: string; name: string; role: string; status: string; phone: string | null; country: string | null; interests: string[];
  notify: Record<string, boolean>; wallet_address: string | null; investor_id: string | null; created_at: string; last_login_at: string | null;
  password_changed_at: string | null; kyc_status: string | null; screening: string | null; professional: boolean | null; kyc_expires: string | null;
};
const SECTIONS = [["profile", "Profile"], ["interests", "Interests"], ["notifications", "Notifications"], ["security", "Security"], ["investor", "Investor & wallet"]] as const;
const INTERESTS: [string, string][] = [["charter", "Charter or stay aboard"], ["invest", "Own units in a yacht"], ["own", "List my yacht"], ["marina", "Run a marina"], ["track", "Just follow yachts"]];
const NOTIFY: [string, string, string][] = [
  ["arrivals", "Arrivals and departures", "When a yacht you follow arrives or leaves, with its proof"],
  ["ais_gaps", "AIS gaps and position alerts", "If a yacht goes quiet on AIS or its signals disagree"],
  ["documents", "Documents and inspections", "Expiring insurance, new surveys and maintenance records"],
  ["bookings", "Bookings and escrow", "Reservations, check-ins and escrow releases"],
  ["payouts", "Payouts and credits", "Earn payouts and Use credits on your units"],
  ["weekly", "Weekly summary", "One email every Monday with your fleet's week"],
];
const call = async (p: string, init?: RequestInit) => {
  const r = await fetch(`/api/gyt${p}`, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : Array.isArray(body.detail) ? body.detail.map((x: { msg: string }) => x.msg).join("; ") : `Request failed (${r.status})`);
  return body;
};
const initials = (n: string) => n.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();

function Save({ state }: { state: string }) {
  return <span className={`savestate ${state}`} role="status">{state === "saving" ? "Saving…" : state === "saved" ? "✓ Saved" : state.startsWith("err:") ? state.slice(4) : ""}</span>;
}

export default function AccountSettings() {
  const [p, setP] = useState<P | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", country: "", wallet: "" });
  const [st, setSt] = useState<Record<string, string>>({});
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [active, setActive] = useState("profile");

  useEffect(() => {
    call("/me/profile").then((x: P) => { setP(x); setForm({ name: x.name, phone: x.phone ?? "", country: x.country ?? "", wallet: x.wallet_address ?? "" }); }).catch(() => {});
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: "-30% 0px -60% 0px" });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);

  async function save(key: string, body: Record<string, unknown>) {
    setSt((s) => ({ ...s, [key]: "saving" }));
    try { const x = await call("/me/profile", { method: "PATCH", body: JSON.stringify(body) }); setP(x); setSt((s) => ({ ...s, [key]: "saved" })); setTimeout(() => setSt((s) => ({ ...s, [key]: "" })), 2200); }
    catch (e) { setSt((s) => ({ ...s, [key]: `err:${(e as Error).message}` })); }
  }
  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) { setSt((s) => ({ ...s, pw: "err:The new passwords do not match" })); return; }
    setSt((s) => ({ ...s, pw: "saving" }));
    try { await call("/me/password", { method: "POST", body: JSON.stringify({ current: pw.current, new: pw.next }) }); setPw({ current: "", next: "", confirm: "" }); setSt((s) => ({ ...s, pw: "saved" })); call("/me/profile").then(setP); }
    catch (e2) { setSt((s) => ({ ...s, pw: `err:${(e2 as Error).message}` })); }
  }

  if (!p) return <main className="wrap page"><div className="skel" style={{ height: 300 }} /></main>;
  const dirty = form.name !== p.name || form.phone !== (p.phone ?? "") || form.country !== (p.country ?? "");
  const pwOk = passwordChecks(pw.next).every((c) => c.ok) && pw.next === pw.confirm && pw.current;
  return (
    <main className="wrap page">
      <div className="acct-head">
        <div className="row" style={{ gap: 16 }}>
          <span className="bigavatar" aria-hidden="true">{initials(p.name)}</span>
          <div><div className="eyebrow">Settings</div><h1>{p.name}</h1>
            <p className="small muted" style={{ margin: 0 }}>{p.email} · member since {new Date(p.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })} · <span className={`pill ${p.status === "active" ? "ok" : "warn"}`}>{p.status}</span></p></div>
        </div>
        <Link className="btn" href="/account">← My GYT</Link>
      </div>
      <div className="settings">
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`} aria-current={active === id ? "true" : undefined}>{l}</a>)}
        </nav>
        <div className="set-main">
          <section id="profile" className="panel set-sec">
            <header><h3>Profile</h3><Save state={st.profile ?? ""} /></header>
            <form className="form2" onSubmit={(e) => { e.preventDefault(); save("profile", { name: form.name, phone: form.phone, country: form.country || undefined }); }}>
              <label className="f" htmlFor="s-name">Full name<input id="s-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" /></label>
              <label className="f" htmlFor="s-email">Email<input id="s-email" value={p.email} disabled /><span className="small muted">Contact support to change your email.</span></label>
              <label className="f" htmlFor="s-phone">Mobile<input id="s-phone" type="tel" value={form.phone} placeholder="+254 700 000000" onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" /></label>
              <label className="f" htmlFor="s-country">Country of residence
                <select id="s-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                  <option value="">Choose…</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                </select></label>
              <div className="row form-actions"><button className="primary" disabled={!dirty || st.profile === "saving"}>Save profile</button>
                {dirty && <button type="button" className="ghost" onClick={() => setForm({ name: p.name, phone: p.phone ?? "", country: p.country ?? "", wallet: form.wallet })}>Discard</button>}</div>
            </form>
          </section>

          <section id="interests" className="panel set-sec">
            <header><h3>Interests</h3><Save state={st.interests ?? ""} /></header>
            <p className="small muted">These shape your dashboard. Changes save as you click.</p>
            <div className="chips">
              {INTERESTS.map(([k, l]) => {
                const on = p.interests.includes(k);
                return <button key={k} className="chip" aria-pressed={on} onClick={() => save("interests", { interests: on ? p.interests.filter((x) => x !== k) : [...p.interests, k] })}>{on ? "✓ " : ""}{l}</button>;
              })}
            </div>
          </section>

          <section id="notifications" className="panel set-sec">
            <header><h3>Notifications</h3><Save state={st.notify ?? ""} /></header>
            <div className="toggles">
              {NOTIFY.map(([k, t, d]) => (
                <label key={k} className="toggle">
                  <span><b>{t}</b><span className="small muted">{d}</span></span>
                  <input type="checkbox" role="switch" checked={!!p.notify[k]} onChange={(e) => save("notify", { notify: { [k]: e.target.checked } })} />
                  <span className="sw" aria-hidden="true" />
                </label>
              ))}
            </div>
            <p className="small muted">Alerts go to {p.email}{p.phone ? ` and ${p.phone}` : ""}.</p>
          </section>

          <section id="security" className="panel set-sec">
            <header><h3>Security</h3><Save state={st.pw ?? ""} /></header>
            <div className="kv"><span>Last sign-in</span><span>{p.last_login_at ? new Date(p.last_login_at).toLocaleString() : "This session"}</span></div>
            <div className="kv"><span>Password last changed</span><span>{p.password_changed_at ? new Date(p.password_changed_at).toLocaleDateString() : "Never"}</span></div>
            <form className="stack" style={{ marginTop: 12, maxWidth: 460 }} onSubmit={changePw}>
              <PasswordField id="pw-cur" label="Current password" value={pw.current} onChange={(v) => setPw({ ...pw, current: v })} autoComplete="current-password" meter={false} />
              <PasswordField id="pw-new" label="New password" value={pw.next} onChange={(v) => setPw({ ...pw, next: v })} />
              <PasswordField id="pw-conf" label="Confirm new password" value={pw.confirm} onChange={(v) => setPw({ ...pw, confirm: v })} meter={false} />
              {pw.confirm && pw.next !== pw.confirm && <span className="ferr">Passwords do not match yet</span>}
              <div><button className="primary" disabled={!pwOk || st.pw === "saving"}>Change password</button></div>
            </form>
          </section>

          <section id="investor" className="panel set-sec">
            <header><h3>Investor &amp; wallet</h3><Save state={st.wallet ?? ""} /></header>
            <div className="kv"><span>Investor profile</span><span>{p.investor_id ? <span className="mono">{p.investor_id}</span> : "Not set up"}</span></div>
            <div className="kv"><span>Eligibility (KYC)</span><span><span className={`pill ${p.kyc_status === "approved" ? "ok" : p.kyc_status ? "warn" : ""}`}>{p.kyc_status ?? "not started"}</span></span></div>
            {p.kyc_expires && <div className="kv"><span>Valid until</span><span>{p.kyc_expires}</span></div>}
            {p.investor_id && <div className="kv"><span>Category</span><span>{p.professional ? "Professional (up to 25% of a yacht)" : "Retail (up to 2% of a yacht)"}</span></div>}
            <form className="row" style={{ marginTop: 12, alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); save("wallet", { wallet_address: form.wallet }); }}>
              <label className="f" htmlFor="s-wallet" style={{ flex: 1, minWidth: 240 }}>Wallet address for units
                <input id="s-wallet" className="mono" placeholder="0x…" value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })} spellCheck={false} /></label>
              <button disabled={form.wallet === (p.wallet_address ?? "")}>Save wallet</button>
            </form>
            <p className="small muted">Units can only be sent to a wallet that has passed eligibility and is on the yacht&apos;s allow-list. {!p.investor_id && <Link href="/earn">Start eligibility →</Link>}</p>
          </section>
        </div>
      </div>
    </main>
  );
}
