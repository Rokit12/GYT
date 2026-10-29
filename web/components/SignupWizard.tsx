"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import PasswordField, { passwordChecks } from "./PasswordField";
import { COUNTRIES } from "@/lib/countries";

type Y = { id: string; name: string; loa_m: string; flag: string; marina_name: string; tokenized: boolean; valuation_usd: string | null; units_total: number; last_position: unknown };

const INTERESTS = [
  { k: "charter", t: "Charter or stay aboard", d: "Book verified yachts and berths, paid through escrow", i: "⚓" },
  { k: "invest", t: "Own units in a yacht", d: "Hold a share of a yacht, then use it or earn from it", i: "◈" },
  { k: "own", t: "List my yacht", d: "Get a verified passport and three-signal tracking", i: "⛵" },
  { k: "marina", t: "Run a marina", d: "Publish berths and let arrivals prove themselves", i: "▦" },
  { k: "track", t: "Just follow yachts", d: "Watch positions and check records", i: "⌖" },
];
const STEPS = ["Account", "About you", "Follow yachts", "Done"];
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

export default function SignupWizard() {
  const nextUrl = useSearchParams().get("next");
  const dest = nextUrl && nextUrl.startsWith("/") && !nextUrl.startsWith("//") ? nextUrl : "/account";
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [f, setF] = useState({ name: "", email: "", password: "", phone: "", country: "", interests: [] as string[], follow: [] as string[], terms: false });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [yachts, setYachts] = useState<Y[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { fetch("/api/gyt/yachts").then((r) => r.json()).then(setYachts).catch(() => {}); }, []);
  useEffect(() => { box.current?.querySelector<HTMLElement>("input, button.pick")?.focus({ preventScroll: true }); }, [step]);

  const problems = useMemo(() => ({
    name: f.name.trim().length < 2 ? "Enter your full name" : "",
    email: !emailOk(f.email) ? "Enter a valid email address" : "",
    password: passwordChecks(f.password).some((c) => !c.ok) ? "Password needs 8+ characters with a letter and a number" : "",
    terms: !f.terms ? "Please accept the terms to continue" : "",
    phone: f.phone && !/^\+?[0-9 ()-]{6,30}$/.test(f.phone.trim()) ? "Use digits, spaces and an optional +" : "",
  }), [f]);
  const stepValid = step === 0 ? !problems.name && !problems.email && !problems.password && !problems.terms : step === 1 ? !problems.phone : true;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k: "interests" | "follow", v: string) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  const show = (k: keyof typeof problems) => (touched[k] || touched._all) && problems[k];

  function go(n: number) {
    if (n > step && !stepValid) { setTouched({ ...touched, _all: true }); return; }
    setTouched({}); setErr(""); setDir(n > step ? 1 : -1); setStep(n);
  }

  async function submit() {
    setBusy(true); setErr("");
    const r = await fetch("/api/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: f.name.trim(), email: f.email.trim(), password: f.password, phone: f.phone.trim() || null,
        country: f.country || null, interests: f.interests, follow: f.follow }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      const d = body.detail;
      setErr(typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg: string }) => x.msg).join("; ") : "Something went wrong. Try again.");
      if (r.status === 409 || /email|password|name/i.test(String(d))) { setDir(-1); setStep(0); }
      return;
    }
    setDone({ name: f.name.trim().split(" ")[0] });
    setDir(1); setStep(3);
  }

  const pct = (step / (STEPS.length - 1)) * 100;
  return (
    <div className="auth wizard-page">
      <div className="wizard panel">
        <ol className="wz-steps" aria-label="Sign-up progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""} aria-current={i === step ? "step" : undefined}>
              <span className="d">{i < step ? "✓" : i + 1}</span><span className="l">{s}</span>
            </li>
          ))}
          <span className="wz-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
        </ol>

        <div className={`wz-body dir${dir}`} key={step} ref={box}
          onKeyDown={(e) => { if (e.key === "Enter" && step < 2 && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") { e.preventDefault(); go(step + 1); } }}>
          {step === 0 && (
            <>
              <div><div className="eyebrow">Step 1 of 3 · Free</div><h1>Create your account</h1>
                <p className="muted small">Browse, track and verify straight away. An admin approves new accounts before bookings and investments open.</p></div>
              <label className="f" htmlFor="su-name">Full name
                <input id="su-name" autoComplete="name" value={f.name} onChange={(e) => set("name", e.target.value)} onBlur={() => setTouched({ ...touched, name: true })} aria-invalid={!!show("name")} />
                {show("name") && <span className="ferr">{problems.name}</span>}
              </label>
              <label className="f" htmlFor="su-email">Email
                <input id="su-email" type="email" autoComplete="email" inputMode="email" value={f.email} onChange={(e) => set("email", e.target.value)} onBlur={() => setTouched({ ...touched, email: true })} aria-invalid={!!show("email")} />
                {show("email") && <span className="ferr">{problems.email}</span>}
              </label>
              <PasswordField id="su-pw" label="Password" value={f.password} onChange={(v) => set("password", v)} />
              <label className="row small check-row"><input type="checkbox" checked={f.terms} onChange={(e) => set("terms", e.target.checked)} style={{ width: "auto" }} />
                I agree to the terms and understand GYT is not a flag registry or investment advice.</label>
              {show("terms") && <span className="ferr">{problems.terms}</span>}
            </>
          )}
          {step === 1 && (
            <>
              <div><div className="eyebrow">Step 2 of 3 · Optional</div><h1>What brings you here?</h1>
                <p className="muted small">Pick any that fit. We use this to set up your dashboard; you can change it later in Settings.</p></div>
              <div className="pickgrid">
                {INTERESTS.map((x) => (
                  <button key={x.k} type="button" className="pick" aria-pressed={f.interests.includes(x.k)} onClick={() => toggle("interests", x.k)}>
                    <span className="pk-i" aria-hidden="true">{x.i}</span><b>{x.t}</b><span>{x.d}</span><span className="pk-tick" aria-hidden="true">✓</span>
                  </button>
                ))}
              </div>
              <div className="form2">
                <label className="f" htmlFor="su-country">Country of residence
                  <select id="su-country" value={f.country} onChange={(e) => set("country", e.target.value)} autoComplete="country">
                    <option value="">Choose…</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </select>
                </label>
                <label className="f" htmlFor="su-phone">Mobile (for booking alerts)
                  <input id="su-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+254 700 000000" value={f.phone} onChange={(e) => set("phone", e.target.value)} onBlur={() => setTouched({ ...touched, phone: true })} aria-invalid={!!show("phone")} />
                  {show("phone") && <span className="ferr">{problems.phone}</span>}
                </label>
              </div>
              {f.interests.includes("invest") && <p className="hint small">Investing needs an eligibility check through a licensed partner. You can start it from your dashboard after sign-up.</p>}
            </>
          )}
          {step === 2 && (
            <>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
                <div><div className="eyebrow">Step 3 of 3 · Optional</div><h1>Follow a few yachts</h1>
                  <p className="muted small">Followed yachts appear on your dashboard with live position, records and alerts.</p></div>
                <button type="button" className="sm" onClick={() => set("follow", f.follow.length === yachts.length ? [] : yachts.map((y) => y.id))}>
                  {f.follow.length === yachts.length && yachts.length ? "Clear all" : "Follow all"}
                </button>
              </div>
              <div className="followgrid">
                {yachts.map((y) => {
                  const price = y.valuation_usd && y.units_total ? Number(y.valuation_usd) / y.units_total : null;
                  const on = f.follow.includes(y.id);
                  return (
                    <button key={y.id} type="button" className="fpick" aria-pressed={on} onClick={() => toggle("follow", y.id)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/media/yachts/${y.id}.jpg`} alt="" onError={(e) => { (e.target as HTMLImageElement).src = "/media/yachts/default.jpg"; }} />
                      <span className="fp-b"><b>{y.name}</b><span>{Number(y.loa_m)} m · {y.marina_name}</span>
                        {y.tokenized && price ? <span className="fp-u">1 unit ≈ {usd(price)}</span> : <span className="fp-u muted">No units issued</span>}</span>
                      <span className="fp-tick" aria-hidden="true">{on ? "✓" : "+"}</span>
                    </button>
                  );
                })}
                {!yachts.length && <p className="muted small">Loading yachts…</p>}
              </div>
            </>
          )}
          {step === 3 && done && (
            <div className="wz-done">
              <div className="burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 25.7}deg` }} />)}<span>✓</span></div>
              <h1>Welcome aboard, {done.name}</h1>
              <ul className="checklist">
                <li className="ok">Account created</li>
                <li className={f.follow.length ? "ok" : ""}>{f.follow.length ? `Following ${f.follow.length} yacht${f.follow.length > 1 ? "s" : ""}` : "Follow yachts from any passport"}</li>
                <li className="wait">Admin approval for bookings and investments (you can browse and track now)</li>
                {f.interests.includes("invest") && <li>Start your investor eligibility check</li>}
                {f.interests.includes("own") && <li>List your yacht and upload its photos</li>}
              </ul>
              <div className="row" style={{ justifyContent: "center" }}>
                <a className="btn primary lg" href={dest}>{dest === "/account" ? "Go to My GYT →" : "Continue where you were →"}</a>
                {dest !== "/account" && <a className="btn lg" href="/account">My GYT</a>}
                <a className="btn lg" href="/yachts">Explore yachts</a>
              </div>
            </div>
          )}
        </div>

        {err && <p className="err" role="alert">{err}</p>}
        {step < 3 && (
          <div className="wz-nav">
            {step > 0 ? <button type="button" onClick={() => go(step - 1)}>← Back</button> : <span className="small muted">Already have an account? <Link href={`/signin${nextUrl ? `?next=${encodeURIComponent(dest)}` : ""}`}>Sign in</Link></span>}
            <span className="row" style={{ gap: 8 }}>
              {step > 0 && step < 2 && <button type="button" className="ghost" onClick={() => go(step + 1)}>Skip</button>}
              {step < 2
                ? <button type="button" className="primary" onClick={() => go(step + 1)} aria-disabled={!stepValid}>Continue →</button>
                : <button type="button" className="primary" onClick={submit} disabled={busy}>{busy ? "Creating your account…" : `Create account${f.follow.length ? ` · follow ${f.follow.length}` : ""}`}</button>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
