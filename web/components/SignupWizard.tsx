"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import PasswordField, { passwordChecks } from "./PasswordField";
import { COUNTRIES } from "@/lib/countries";

/*
  Sign-up is for yacht owners and the people they invite (the API enforces it too):
    - "I own a yacht": vessel details + the certificate of registry. The account is pending until
      the automated checks and an admin approve it.
    - "I have an invite": a single-use code from a yacht owner (captain, crew) or from GYT.
  Anyone can browse, see the map and check records without an account.
*/

const INTERESTS = [
  { k: "charter", t: "Charter or stay aboard", d: "Book verified yachts and berths, paid through escrow", i: "⚓" },
  { k: "invest", t: "Own units in a yacht", d: "Hold a share of a yacht, then use it or earn from it", i: "◈" },
  { k: "own", t: "List my yacht", d: "Get a verified passport and three-signal tracking", i: "⛵" },
  { k: "marina", t: "Run a marina", d: "Publish berths and let arrivals prove themselves", i: "▦" },
];
const STEPS = ["Account", "Your yacht", "About you", "Done"];
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
const mmsiOk = (m: string) => !m || /^\d{9}$/.test(m.trim());
function imoOk(i: string) {
  const d = i.trim().toUpperCase().replace(/^IMO\s*/, "");
  if (!d) return true;
  if (!/^\d{7}$/.test(d)) return false;
  let s = 0;
  for (let k = 0; k < 6; k++) s += Number(d[k]) * (7 - k);
  return s % 10 === Number(d[6]);
}
const MAX_DOC = 10 * 1024 * 1024;
type Check = { key: string; ok: boolean; msg: string };

export default function SignupWizard() {
  const params = useSearchParams();
  const nextUrl = params.get("next");
  const dest = nextUrl && nextUrl.startsWith("/") && !nextUrl.startsWith("//") ? nextUrl : "/account";
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [f, setF] = useState({
    name: "", email: "", password: "", phone: "", country: "", interests: [] as string[], terms: false,
    join: (params.get("invite") ? "invite" : "") as "" | "owner" | "invite", code: params.get("invite") ?? "",
    vName: "", vFlag: "", vLoa: "", vMmsi: "", vImo: "", vReg: "",
  });
  const [doc, setDoc] = useState<File | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; status: string; checks: Check[]; uploadErr: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const problems = useMemo(() => ({
    name: f.name.trim().length < 2 ? "Enter your full name" : "",
    email: !emailOk(f.email) ? "Enter a valid email address" : "",
    password: passwordChecks(f.password).some((c) => !c.ok) ? "Password needs 8+ characters with a letter and a number" : "",
    terms: !f.terms ? "Please accept the terms to continue" : "",
    join: !f.join ? "Choose how you're joining" : "",
    code: f.join === "invite" && !/^GYT-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(f.code.trim()) ? "Invite codes look like GYT-ABCD-EF23" : "",
    vName: f.join === "owner" && f.vName.trim().length < 2 ? "Enter the yacht's name" : "",
    vFlag: f.join === "owner" && !f.vFlag ? "Choose the flag" : "",
    vLoa: f.join === "owner" && !(Number(f.vLoa) > 3 && Number(f.vLoa) <= 200) ? "Length in metres, e.g. 24.5" : "",
    vIds: f.join === "owner" && !f.vMmsi.trim() && !f.vImo.trim() ? "Give the MMSI or IMO number (or both)" : "",
    vMmsi: f.join === "owner" && !mmsiOk(f.vMmsi) ? "MMSI is 9 digits" : "",
    vImo: f.join === "owner" && !imoOk(f.vImo) ? "That IMO number's check digit is wrong" : "",
    vReg: f.join === "owner" && f.vReg.trim().length < 2 ? "Enter the registry or official number" : "",
    doc: f.join === "owner" && !doc ? "Attach the certificate of registry" : "",
    phone: f.phone && !/^\+?[0-9 ()-]{6,30}$/.test(f.phone.trim()) ? "Use digits, spaces and an optional +" : "",
  }), [f, doc]);
  const s0 = ["name", "email", "password", "terms"] as const;
  const s1 = ["join", "code", "vName", "vFlag", "vLoa", "vIds", "vMmsi", "vImo", "vReg", "doc"] as const;
  const stepValid = step === 0 ? s0.every((k) => !problems[k]) : step === 1 ? s1.every((k) => !problems[k]) : step === 2 ? !problems.phone : true;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (v: string) => set("interests", f.interests.includes(v) ? f.interests.filter((x) => x !== v) : [...f.interests, v]);
  const show = (k: keyof typeof problems) => (touched[k] || touched._all) && problems[k];

  function go(n: number) {
    if (n > step && !stepValid) { setTouched({ ...touched, _all: true }); return; }
    setTouched({}); setErr(""); setDir(n > step ? 1 : -1); setStep(n);
    setTimeout(() => box.current?.querySelector<HTMLElement>("input, button.pick")?.focus({ preventScroll: true }), 0);
  }

  async function submit() {
    if (!stepValid) { setTouched({ ...touched, _all: true }); return; }
    setBusy(true); setErr("");
    const flagName = COUNTRIES.find(([c]) => c === f.vFlag)?.[1] ?? f.vFlag;
    const body = {
      name: f.name.trim(), email: f.email.trim(), password: f.password, phone: f.phone.trim() || null,
      country: f.country || null, interests: f.interests, join_as: f.join,
      ...(f.join === "owner" ? { vessel: { name: f.vName.trim(), flag: flagName, loa_m: Number(f.vLoa), mmsi: f.vMmsi.trim() || null,
        imo: f.vImo.trim() || null, registry_number: f.vReg.trim() } } : { invite_code: f.code.trim().toUpperCase() }),
    };
    const r = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) {
      setBusy(false);
      const d = res.detail;
      const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg: string }) => x.msg).join("; ") : "Something went wrong. Try again.";
      setErr(msg);
      if (r.status === 409 || /email|password|name/i.test(msg)) { setDir(-1); setStep(0); }
      else if (/invite|MMSI|IMO|flag|yacht/i.test(msg)) { setDir(-1); setStep(1); }
      return;
    }
    let checks: Check[] = [];
    let uploadErr = "";
    if (f.join === "owner" && doc) {
      // the session cookie is set now, so the proxy sends the upload as this new user
      const u = await fetch("/api/gyt/me/registry-document", { method: "POST", headers: { "Content-Type": doc.type || "application/octet-stream" }, body: doc });
      const ub = await u.json().catch(() => ({}));
      if (u.ok) checks = ub.screening?.checks ?? [];
      else uploadErr = typeof ub.detail === "string" ? ub.detail : "The certificate didn't upload. Add it from My GYT.";
    }
    setBusy(false);
    setDone({ name: f.name.trim().split(" ")[0], status: res.user?.status ?? "pending", checks, uploadErr });
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
          onKeyDown={(e) => { if (e.key === "Enter" && step === 0 && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") { e.preventDefault(); go(step + 1); } }}>
          {step === 0 && (
            <>
              <div><div className="eyebrow">Step 1 of 3</div><h1>Create your account</h1>
                <p className="muted small">GYT accounts are for yacht owners and the people they invite. Anyone can browse yachts, the map and records without one.</p></div>
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
              <div><div className="eyebrow">Step 2 of 3</div><h1>How are you joining?</h1>
                <p className="muted small">This keeps GYT to people with a real connection to a yacht.</p></div>
              <div className="pickgrid two">
                <button type="button" className="pick" aria-pressed={f.join === "owner"} onClick={() => set("join", "owner")}>
                  <span className="pk-i" aria-hidden="true">⛵</span><b>I own a yacht</b><span>Give its details and certificate of registry. We check them before your account opens.</span><span className="pk-tick" aria-hidden="true">✓</span>
                </button>
                <button type="button" className="pick" aria-pressed={f.join === "invite"} onClick={() => set("join", "invite")}>
                  <span className="pk-i" aria-hidden="true">✉</span><b>I have an invite</b><span>From a yacht owner (captain, crew) or from GYT (investors, marinas).</span><span className="pk-tick" aria-hidden="true">✓</span>
                </button>
              </div>
              {show("join") && <span className="ferr">{problems.join}</span>}
              {f.join === "invite" && (
                <label className="f" htmlFor="su-code">Invite code
                  <input id="su-code" className="mono" placeholder="GYT-ABCD-EF23" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} aria-invalid={!!show("code")} />
                  {show("code") && <span className="ferr">{problems.code}</span>}
                </label>
              )}
              {f.join === "owner" && (
                <div className="form2">
                  <label className="f" htmlFor="v-name">Yacht name
                    <input id="v-name" value={f.vName} onChange={(e) => set("vName", e.target.value)} aria-invalid={!!show("vName")} />
                    {show("vName") && <span className="ferr">{problems.vName}</span>}</label>
                  <label className="f" htmlFor="v-flag">Flag
                    <select id="v-flag" value={f.vFlag} onChange={(e) => set("vFlag", e.target.value)} aria-invalid={!!show("vFlag")}>
                      <option value="">Choose…</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                    </select>{show("vFlag") && <span className="ferr">{problems.vFlag}</span>}</label>
                  <label className="f" htmlFor="v-loa">Length overall (m)
                    <input id="v-loa" inputMode="decimal" value={f.vLoa} onChange={(e) => set("vLoa", e.target.value)} aria-invalid={!!show("vLoa")} />
                    {show("vLoa") && <span className="ferr">{problems.vLoa}</span>}</label>
                  <label className="f" htmlFor="v-reg">Registry / official number
                    <input id="v-reg" value={f.vReg} onChange={(e) => set("vReg", e.target.value)} aria-invalid={!!show("vReg")} />
                    {show("vReg") && <span className="ferr">{problems.vReg}</span>}</label>
                  <label className="f" htmlFor="v-mmsi">MMSI (9 digits, from the radio licence)
                    <input id="v-mmsi" inputMode="numeric" className="mono" value={f.vMmsi} onChange={(e) => set("vMmsi", e.target.value)} aria-invalid={!!(show("vMmsi") || show("vIds"))} />
                    {show("vMmsi") && <span className="ferr">{problems.vMmsi}</span>}</label>
                  <label className="f" htmlFor="v-imo">IMO number (if it has one)
                    <input id="v-imo" inputMode="numeric" className="mono" value={f.vImo} onChange={(e) => set("vImo", e.target.value)} aria-invalid={!!show("vImo")} />
                    {show("vImo") && <span className="ferr">{problems.vImo}</span>}</label>
                  {show("vIds") && <span className="ferr" style={{ gridColumn: "1 / -1" }}>{problems.vIds}</span>}
                  <label className="f filepick" htmlFor="v-doc" style={{ gridColumn: "1 / -1" }}>Certificate of registry (PDF or photo, up to 10 MB)
                    <input id="v-doc" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"
                      onChange={(e) => { const x = e.target.files?.[0] ?? null; setDoc(x && x.size <= MAX_DOC ? x : null); if (x && x.size > MAX_DOC) setErr("That file is over 10 MB."); }} />
                    {doc && <span className="small muted">{doc.name} · {(doc.size / 1024).toFixed(0)} KB</span>}
                    {show("doc") && <span className="ferr">{problems.doc}</span>}
                  </label>
                  <p className="hint small" style={{ gridColumn: "1 / -1" }}>Our autopilot checks the MMSI and IMO, makes sure no one else has claimed this yacht, and reads the certificate. An admin then opens your account, usually within a day.</p>
                </div>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <div><div className="eyebrow">Step 3 of 3 · Optional</div><h1>What do you want to do on GYT?</h1>
                <p className="muted small">Pick any that fit. We use this to set up your dashboard.</p></div>
              <div className="pickgrid">
                {INTERESTS.map((x) => (
                  <button key={x.k} type="button" className="pick" aria-pressed={f.interests.includes(x.k)} onClick={() => toggle(x.k)}>
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
            </>
          )}
          {step === 3 && done && (
            <div className="wz-done">
              <div className="burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 25.7}deg` }} />)}<span>✓</span></div>
              <h1>Welcome aboard, {done.name}</h1>
              <ul className="checklist">
                <li className="ok">Account created</li>
                {f.join === "invite" && <li className="ok">Invite accepted: your account is open</li>}
                {f.join === "owner" && (done.uploadErr
                  ? <li className="wait">{done.uploadErr}</li>
                  : <li className="ok">Certificate of registry received</li>)}
                {done.checks.map((c) => <li key={c.key} className={c.ok ? "ok" : "wait"}>{c.msg}</li>)}
                {done.status !== "active" && <li className="wait">An admin opens your account once the checks are done. You can browse and track now.</li>}
              </ul>
              <div className="row" style={{ justifyContent: "center" }}>
                <a className="btn primary lg" href={dest}>{dest === "/account" ? "Go to My GYT →" : "Continue where you were →"}</a>
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
              {step === 2 && <button type="button" className="ghost" onClick={submit} disabled={busy}>Skip</button>}
              {step < 2
                ? <button type="button" className="primary" onClick={() => go(step + 1)} aria-disabled={!stepValid}>Continue →</button>
                : <button type="button" className="primary" onClick={submit} disabled={busy}>{busy ? "Creating your account…" : "Create account"}</button>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
