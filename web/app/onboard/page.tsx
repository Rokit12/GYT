"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import { hashFile } from "@/lib/merkle";

const STEPS = ["Vessel", "Documents", "Review & mint"] as const;
const DOC_KINDS = [
  ["registry", "Certificate of Registry", true],
  ["title", "Bill of sale or builder's certificate", true],
  ["insurance", "Insurance certificate (hull & P&I)", true],
  ["survey", "Condition survey, under 12 months", true],
  ["class", "Class certificate", false],
] as const;

type Marina = { id: string; name: string };
type Doc = { kind: string; filename: string; sha256: string };

export default function Onboard() {
  const [step, setStep] = useState(0);
  const [marinas, setMarinas] = useState<Marina[]>([]);
  const [v, setV] = useState({
    name: "Lamu Breeze", mmsi: "634012456", flag: "Kenya", loa_m: 32, beam_m: 7.2, year_built: 2020,
    builder: "Turkish yard, GRP", home_marina_id: "MARINA-MBA-001", berth_code: "K-2",
    valuation_usd: 5_600_000, charter_week_usd: 44_000, units_total: 10_000,
  });
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [result, setResult] = useState<{ id: string; docs_root: string } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    call<Marina[]>("/marinas").then(setMarinas);
  }, []);

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV({ ...v, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value });

  async function onFile(kind: string, f: File | undefined) {
    if (!f) return;
    setDocs({ ...docs, [kind]: { kind, filename: f.name, sha256: await hashFile(f) } });
  }

  const docsOk = DOC_KINDS.filter(([, , req]) => req).every(([k]) => docs[k]);

  async function mint() {
    setErr("");
    try {
      setResult(await call("/yachts", { method: "POST", body: JSON.stringify({ ...v, documents: Object.values(docs) }) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const field = (k: keyof typeof v, label: string, type = "text") => (
    <label className="f" htmlFor={k}>
      {label}
      <input id={k} type={type} value={v[k] as string | number} onChange={set(k)} />
    </label>
  );

  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">Owner onboarding</div>
        <h1>Put your yacht on GYT</h1>
        <p className="lede">Documents are hashed in your browser before upload. Only the hashes go on-chain.</p>
      </div>
      <div className="panel wiz">
        <div className="wsteps">
          {STEPS.map((s, i) => (
            <button key={s} aria-current={i === step ? "step" : undefined} onClick={() => setStep(i)}>
              {i + 1}. {s}
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          {step === 0 && (
            <>
              <h2>Vessel identity</h2>
              <div className="form">
                {field("name", "Yacht name")}
                {field("mmsi", "MMSI")}
                {field("flag", "Flag state")}
                {field("loa_m", "Length overall (m)", "number")}
                {field("beam_m", "Beam (m)", "number")}
                {field("year_built", "Year built", "number")}
                {field("builder", "Builder")}
                <label className="f" htmlFor="home">Home marina
                  <select id="home" value={v.home_marina_id} onChange={set("home_marina_id")}>
                    {marinas.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                {field("berth_code", "Berth")}
                {field("valuation_usd", "Valuation (USD)", "number")}
                {field("charter_week_usd", "Weekly charter (USD)", "number")}
                {field("units_total", "Units to issue (0 = twin only)", "number")}
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <h2>Documents</h2>
              {DOC_KINDS.map(([k, label, req]) => (
                <div key={k} className="kv" style={{ alignItems: "center" }}>
                  <span>
                    <b style={{ color: "var(--ink)" }}>{label}</b> {req ? "" : "(optional)"}
                    <br />
                    <span className="mono small">{docs[k] ? `${docs[k].filename} · ${docs[k].sha256.slice(0, 24)}…` : "Not provided"}</span>
                  </span>
                  <span>
                    <input aria-label={`Upload ${label}`} type="file" accept=".pdf,image/*" onChange={(e) => onFile(k, e.target.files?.[0])} />
                  </span>
                </div>
              ))}
            </>
          )}
          {step === 2 && (
            <>
              <h2>Review &amp; mint</h2>
              <div className="check">
                <div><span>{v.name && v.flag ? "✓" : "✕"}</span><b>Vessel</b> {v.name}, {v.loa_m} m, {v.flag}</div>
                <div><span>{docsOk ? "✓" : "✕"}</span><b>Documents</b> {Object.keys(docs).length} hashed</div>
              </div>
              {result ? (
                <div className="verdict ok"><b>Submitted as {result.id}</b><span className="small">Our team will verify your documents and mint the passport, usually within 3–5 days. You&apos;ll see it under Explore once it&apos;s minted.</span><span className="mono small">Documents root {result.docs_root}</span></div>
              ) : (
                <button className="primary" disabled={!docsOk} onClick={mint}>Submit for verification</button>
              )}
              {!docsOk && <p className="err">Upload the four required documents first.</p>}
              {err && <p className="err">{err}</p>}
            </>
          )}
          <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
            {step < 2 && <button className="primary" onClick={() => setStep(step + 1)}>Continue</button>}
          </div>
        </div>
      </div>
    </main>
  );
}
