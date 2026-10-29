"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { call } from "@/lib/api";
import { hashFile } from "@/lib/merkle";
import { shrink, uploadPhoto } from "@/lib/photos";

const STEPS = ["Vessel", "Documents", "Photos", "Review"] as const;
const DOC_KINDS = [
  ["registry", "Certificate of Registry", true],
  ["title", "Bill of sale or builder's certificate", true],
  ["insurance", "Insurance certificate (hull & P&I)", true],
  ["survey", "Condition survey, under 12 months", true],
  ["class", "Class certificate", false],
] as const;

type Marina = { id: string; name: string };
type Doc = { kind: string; filename: string; sha256: string };
type Pic = { key: string; file: File; url: string; caption: string; state?: "up" | "ok" | "err"; p?: number; err?: string };
type V = { name: string; mmsi: string; flag: string; loa_m: string; beam_m: string; year_built: string; builder: string; home_marina_id: string;
  berth_code: string; valuation_usd: string; charter_week_usd: string; units_total: string };

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export default function Onboard() {
  const [step, setStep] = useState(0);
  const [marinas, setMarinas] = useState<Marina[]>([]);
  const [v, setV] = useState<V>({ name: "", mmsi: "", flag: "", loa_m: "", beam_m: "", year_built: "", builder: "", home_marina_id: "",
    berth_code: "", valuation_usd: "", charter_week_usd: "", units_total: "0" });
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [hashing, setHashing] = useState<string | null>(null);
  const [pics, setPics] = useState<Pic[]>([]);
  const [drag, setDrag] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; docs_root: string } | null>(null);
  const [err, setErr] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => { call<Marina[]>("/marinas").then((m) => { setMarinas(m); setV((x) => ({ ...x, home_marina_id: x.home_marina_id || m[0]?.id || "" })); }); }, []);

  const vErr = useMemo(() => {
    const e: Partial<Record<keyof V, string>> = {};
    if (!v.name.trim()) e.name = "Enter the yacht's name";
    if (!v.flag.trim()) e.flag = "Enter the flag state";
    if (v.mmsi && !/^\d{9}$/.test(v.mmsi)) e.mmsi = "MMSI is 9 digits";
    if (!(Number(v.loa_m) > 2 && Number(v.loa_m) < 250)) e.loa_m = "Length between 2 and 250 m";
    if (!(Number(v.beam_m) > 1 && Number(v.beam_m) < 40)) e.beam_m = "Beam between 1 and 40 m";
    if (v.year_built && !(Number(v.year_built) >= 1900 && Number(v.year_built) <= 2030)) e.year_built = "Year between 1900 and 2030";
    if (Number(v.units_total) > 0 && !(Number(v.valuation_usd) > 0)) e.valuation_usd = "Units need a valuation";
    return e;
  }, [v]);
  const docsOk = DOC_KINDS.filter(([, , req]) => req).every(([k]) => docs[k]);
  const vesselOk = Object.keys(vErr).length === 0;
  const unit = Number(v.units_total) > 0 && Number(v.valuation_usd) > 0 ? Number(v.valuation_usd) / Number(v.units_total) : null;

  function next() {
    if (step === 0 && !vesselOk) { setTouched(true); return; }
    setTouched(false); setStep(step + 1);
  }
  async function onFile(kind: string, f: File | undefined) {
    if (!f) return;
    setHashing(kind);
    setDocs({ ...docs, [kind]: { kind, filename: f.name, sha256: await hashFile(f) } });
    setHashing(null);
  }
  function addPics(files: FileList | File[]) {
    const ok = Array.from(files).filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type)).slice(0, 12 - pics.length);
    setPics((p) => [...p, ...ok.map((file) => ({ key: `${file.name}${file.size}${Math.random()}`, file, url: URL.createObjectURL(file), caption: "" }))]);
    if (ok.length < Array.from(files).length) setErr("Some files were skipped: use JPEG, PNG or WebP, up to 12 photos.");
  }
  const move = (i: number, d: number) => setPics((p) => { const a = [...p]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });

  async function submit() {
    setErr(""); setBusy(true);
    try {
      const body = { ...v, mmsi: v.mmsi || null, berth_code: v.berth_code || null, builder: v.builder || null,
        loa_m: num(v.loa_m), beam_m: num(v.beam_m), year_built: num(v.year_built), valuation_usd: num(v.valuation_usd),
        charter_week_usd: num(v.charter_week_usd), units_total: num(v.units_total) ?? 0, documents: Object.values(docs) };
      const r = await call<{ id: string; docs_root: string }>("/yachts", { method: "POST", body: JSON.stringify(body) });
      setResult(r);
      // Photos go up in order; the first becomes the cover.
      for (const p of pics) {
        setPics((x) => x.map((y) => (y.key === p.key ? { ...y, state: "up", p: 0 } : y)));
        try {
          await uploadPhoto(r.id, await shrink(p.file), p.caption, (pr) => setPics((x) => x.map((y) => (y.key === p.key ? { ...y, p: pr } : y))));
          setPics((x) => x.map((y) => (y.key === p.key ? { ...y, state: "ok", p: 1 } : y)));
        } catch (e) {
          setPics((x) => x.map((y) => (y.key === p.key ? { ...y, state: "err", err: (e as Error).message } : y)));
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  const field = (k: keyof V, label: string, o: { type?: string; ph?: string; hint?: string; opt?: boolean } = {}) => (
    <label className="f" htmlFor={k}>
      <span>{label}{o.opt && <span className="muted"> (optional)</span>}</span>
      <input id={k} type={o.type ?? "text"} inputMode={o.type === "number" ? "decimal" : undefined} placeholder={o.ph} value={v[k]}
        onChange={(e) => setV({ ...v, [k]: e.target.value })} aria-invalid={touched && !!vErr[k]} />
      {touched && vErr[k] ? <span className="ferr">{vErr[k]}</span> : o.hint ? <span className="small muted">{o.hint}</span> : null}
    </label>
  );

  return (
    <main className="wrap page">
      <div>
        <div className="eyebrow">List your yacht</div>
        <h1>Put your yacht on GYT</h1>
        <p className="lede">Four short steps. Documents are fingerprinted in your browser; only their hashes go on-chain. Photos are resized before upload.</p>
      </div>
      <div className="panel wiz2">
        <ol className="wz-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "on" : ""} aria-current={i === step ? "step" : undefined}>
              <button type="button" onClick={() => (i <= step || (i === step + 1 && vesselOk)) && setStep(i)} className="wz-b">
                <span className="d">{i < step ? "✓" : i + 1}</span><span className="l">{s}</span>
              </button>
            </li>
          ))}
          <span className="wz-bar" aria-hidden="true"><i style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} /></span>
        </ol>

        <div className="wz-body dir1" key={step}>
          {step === 0 && (
            <>
              <h2>Vessel identity</h2>
              <div className="form2">
                {field("name", "Yacht name", { ph: "e.g. Lamu Breeze" })}
                {field("flag", "Flag state", { ph: "e.g. Kenya" })}
                {field("mmsi", "MMSI", { ph: "9 digits", opt: true, hint: "Lets us match your yacht on public AIS" })}
                {field("builder", "Builder", { ph: "e.g. Turkish yard, GRP", opt: true })}
                {field("loa_m", "Length overall (m)", { type: "number", ph: "32" })}
                {field("beam_m", "Beam (m)", { type: "number", ph: "7.2" })}
                {field("year_built", "Year built", { type: "number", ph: "2020", opt: true })}
                <label className="f" htmlFor="home">Home marina
                  <select id="home" value={v.home_marina_id} onChange={(e) => setV({ ...v, home_marina_id: e.target.value })}>
                    {marinas.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                {field("berth_code", "Berth", { ph: "e.g. K-2", opt: true })}
                {field("charter_week_usd", "Weekly charter rate (USD)", { type: "number", ph: "44000", opt: true })}
                {field("valuation_usd", "Latest valuation (USD)", { type: "number", ph: "5600000", opt: true })}
                {field("units_total", "Units to issue", { type: "number", hint: "0 = passport and tracking only" })}
              </div>
              {unit && <p className="hint small">With these numbers, <b>1 unit ≈ ${Math.round(unit).toLocaleString()}</b> ({(100 / Number(v.units_total)).toPrecision(2)}% of the yacht). Units are offered only through a licensed partner.</p>}
            </>
          )}
          {step === 1 && (
            <>
              <h2>Documents</h2>
              <p className="small muted" style={{ margin: 0 }}>PDF or images. Each file is hashed on this device; the file itself is stored encrypted.</p>
              <div className="doclist">
                {DOC_KINDS.map(([k, label, req]) => (
                  <label key={k} className={`docrow ${docs[k] ? "ok" : ""}`}>
                    <span className="doc-ic" aria-hidden="true">{docs[k] ? "✓" : hashing === k ? "…" : "＋"}</span>
                    <span className="doc-b"><b>{label}</b>{!req && <span className="muted"> (optional)</span>}<br />
                      <span className="mono small muted">{docs[k] ? `${docs[k].filename} · ${docs[k].sha256.slice(0, 20)}…` : hashing === k ? "Fingerprinting…" : "Choose file"}</span></span>
                    <input type="file" accept=".pdf,image/*" className="sr" onChange={(e) => onFile(k, e.target.files?.[0])} />
                  </label>
                ))}
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
                <div><h2>Photos</h2><p className="small muted" style={{ margin: 0 }}>Add up to 12. The first photo is the cover shown on the map, in search and on the passport. Use the arrows to reorder.</p></div>
                <span className="small muted">{pics.length} / 12</span>
              </div>
              <div className={`drop ${drag ? "over" : ""}`} role="button" tabIndex={0} onClick={() => picker.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && picker.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); addPics(e.dataTransfer.files); }}>
                <span className="drop-ic" aria-hidden="true">⇪</span><b>Drop photos here, or click to choose</b>
                <span className="small muted">JPEG, PNG or WebP · exterior, deck, saloon and cabins work best</span>
                <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addPics(e.target.files); e.target.value = ""; }} />
              </div>
              {pics.length > 0 && (
                <div className="pgrid">
                  {pics.map((p, i) => (
                    <figure key={p.key} className={`ph ${i === 0 ? "cover" : ""}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt="" />
                      {i === 0 && <span className="covertag">Cover</span>}
                      <figcaption>
                        <input value={p.caption} placeholder="Caption (optional)" maxLength={140} aria-label="Caption"
                          onChange={(e) => setPics((x) => x.map((y) => (y.key === p.key ? { ...y, caption: e.target.value } : y)))} />
                        <span className="row" style={{ gap: 2 }}>
                          <button className="sm ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier">←</button>
                          <button className="sm ghost" onClick={() => move(i, 1)} disabled={i === pics.length - 1} aria-label="Move later">→</button>
                          <button className="sm ghost" onClick={() => setPics((x) => x.filter((y) => y.key !== p.key))} aria-label="Remove photo">×</button>
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <h2>Review</h2>
              <div className="review">
                <div className={vesselOk ? "ok" : "bad"}><span>{vesselOk ? "✓" : "!"}</span><b>Vessel</b><span>{v.name || "—"}, {v.loa_m || "?"} m, {v.flag || "—"}</span><button className="sm ghost" onClick={() => setStep(0)}>Edit</button></div>
                <div className={docsOk ? "ok" : "bad"}><span>{docsOk ? "✓" : "!"}</span><b>Documents</b><span>{Object.keys(docs).length} fingerprinted{docsOk ? "" : " · 4 required"}</span><button className="sm ghost" onClick={() => setStep(1)}>Edit</button></div>
                <div className={pics.length ? "ok" : ""}><span>{pics.length ? "✓" : "○"}</span><b>Photos</b><span>{pics.length ? `${pics.length} ready, cover chosen` : "None yet; you can add them later"}</span><button className="sm ghost" onClick={() => setStep(2)}>Edit</button></div>
                {unit && <div className="ok"><span>◈</span><b>Units</b><span>{Number(v.units_total).toLocaleString()} units · 1 unit ≈ ${Math.round(unit).toLocaleString()}</span><span /></div>}
              </div>
              {pics.some((p) => p.state) && (
                <div className="pgrid sm">{pics.map((p) => (
                  <figure key={p.key} className={`ph up ${p.state === "err" ? "bad" : ""}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt="" />
                    <figcaption>{p.state === "ok" ? "✓ Uploaded" : p.state === "err" ? <span className="ferr">{p.err}</span> : <span className="prog"><i style={{ width: `${Math.round((p.p ?? 0) * 100)}%` }} /></span>}</figcaption>
                  </figure>))}</div>
              )}
              {result ? (
                <div className="verdict ok">
                  <b>Submitted as {result.id}</b>
                  <span className="small">Our team will verify your documents and mint the passport, usually within 3–5 days. Track progress in My GYT; you can add or change photos from the yacht&apos;s page any time.</span>
                  {result.docs_root && <span className="mono small">Documents root {result.docs_root}</span>}
                  <span className="row"><Link className="btn primary" href="/account">Go to My GYT</Link><Link className="btn" href={`/yachts/${result.id}#photos`}>Manage photos</Link></span>
                </div>
              ) : (
                <button className="primary lg" disabled={!docsOk || !vesselOk || busy} onClick={submit}>{busy ? "Submitting…" : "Submit for verification"}</button>
              )}
              {!docsOk && <p className="err">Upload the four required documents first.</p>}
            </>
          )}
          {err && <p className="err" role="alert">{err}</p>}
        </div>
        <div className="wz-nav">
          <button disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>← Back</button>
          {step < 3 && <button className="primary" onClick={next}>{step === 2 && !pics.length ? "Skip for now →" : "Continue →"}</button>}
        </div>
      </div>
    </main>
  );
}
