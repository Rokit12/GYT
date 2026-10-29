"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AUDIENCES, FLOW, JOURNEYS, type Audience } from "@/lib/journeys";

const img = (k: string) => `/media/yachts/${k.endsWith("-a") ? k.slice(0, -2) : k}.jpg`;

/** Audience tabs with a sliding indicator, a step list with a progress rail, and a detail panel. */
export function Journey() {
  const [aud, setAud] = useState<Audience>("guest");
  const [step, setStep] = useState(0);
  const tabs = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const L = JOURNEYS[aud], s = L[step];

  useLayoutEffect(() => {
    const place = () => {
      const t = tabs.current, on = t?.querySelector<HTMLElement>('[aria-selected="true"]'), ink = t?.querySelector<HTMLElement>(".aud-ink");
      if (t && on && ink) { const a = t.getBoundingClientRect(), r = on.getBoundingClientRect(); ink.style.width = `${r.width}px`; ink.style.transform = `translateX(${r.left - a.left}px)`; }
      const bs = list.current?.querySelectorAll<HTMLElement>("button"), f = list.current?.querySelector<HTMLElement>(".fill");
      if (bs?.length && f) { const top = bs[0].offsetTop + bs[0].offsetHeight / 2, cur = bs[step].offsetTop + bs[step].offsetHeight / 2; f.style.top = `${top}px`; f.style.height = `${cur - top}px`; }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [aud, step]);

  function pick(a: Audience) { setAud(a); setStep(0); }
  function keys(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = AUDIENCES.findIndex(([a]) => a === aud);
    const n = AUDIENCES[(i + (e.key === "ArrowRight" ? 1 : AUDIENCES.length - 1)) % AUDIENCES.length][0];
    pick(n);
    requestAnimationFrame(() => tabs.current?.querySelector<HTMLElement>(`[data-aud="${n}"]`)?.focus());
  }

  return (
    <>
      <div className="aud" role="tablist" aria-label="Choose your path" ref={tabs} onKeyDown={keys}>
        {AUDIENCES.map(([a, label]) => (
          <button key={a} role="tab" data-aud={a} aria-selected={a === aud} tabIndex={a === aud ? 0 : -1} onClick={() => pick(a)}>{label}</button>
        ))}
        <span className="aud-ink" aria-hidden="true" />
      </div>
      <div className="journey">
        <ol className="jsteps" ref={list}>
          {L.map((x, i) => (
            <li key={`${aud}${i}`}>
              <button type="button" aria-current={i === step ? "step" : undefined} className={i < step ? "done" : ""} onClick={() => setStep(i)}>
                <span className="n">{i + 1}</span><span><b>{x.t}</b><small>{x.s}</small></span>
              </button>
            </li>
          ))}
          <span className="fill" aria-hidden="true" />
        </ol>
        <div className="jpanel" role="tabpanel" aria-live="polite" key={`${aud}${step}`}>
          <div className="jimg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(s.img)} alt="" />
            <span className="tag">{String(step + 1).padStart(2, "0")}</span>
          </div>
          <div className="prog"><i style={{ width: `${((step + 1) / L.length) * 100}%` }} /></div>
          <div className="jbody">
            <div className="eyebrow">Step {step + 1} of {L.length}</div>
            <h3>{s.t}</h3>
            <p className="muted" style={{ margin: 0 }}>{s.d}</p>
            <ul>{s.b.map((b) => <li key={b}>{b}</li>)}</ul>
            <div className="jnav">
              <Link className="btn primary" href={s.cta[1]}>{s.cta[0]} →</Link>
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="sm" disabled={step === 0} onClick={() => setStep(step - 1)} aria-label="Previous step">←</button>
                <button type="button" className="sm" disabled={step === L.length - 1} onClick={() => setStep(step + 1)} aria-label="Next step">→</button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const NODES: { k: string; cls: string; i: string; b: string; s: string }[][] = [
  [
    { k: "gps", cls: "src", i: "⌖", b: "Signed GPS", s: "Onboard tracker signs every fix" },
    { k: "ais", cls: "src", i: "≋", b: "AIS", s: "Public ship transponder feed" },
    { k: "sar", cls: "src", i: "◎", b: "Satellite radar", s: "Sentinel-1 sees hulls, even dark ones" },
  ],
  [{ k: "fuse", cls: "mid", i: "✓", b: "Agreement check", s: "Counts only when signals agree within 1.5 km" }],
  [{ k: "hash", cls: "mid", i: "#", b: "SHA-256 record", s: "Every event becomes a 64-character hash" }],
  [{ k: "anchor", cls: "end", i: "⛓", b: "Anchored on-chain", s: "Batches sealed every few minutes" }],
];

/** The three-signal pipeline. Hover or tap a stage to read what it does. */
export function Flow() {
  const [k, setK] = useState("gps");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const node = (n: (typeof NODES)[0][0]) => (
    <button key={n.k} type="button" className={`fnode ${n.cls} ${mounted && k === n.k ? "on" : ""}`} onPointerOver={() => setK(n.k)} onFocus={() => setK(n.k)} onClick={() => setK(n.k)}>
      <i>{n.i}</i><b>{n.b}</b><span>{n.s}</span>
    </button>
  );
  return (
    <>
      <div className="flow">
        <div className="fcol">{NODES[0].map(node)}</div>
        <div className="flink" aria-hidden="true"><span /><span /><span /></div>
        {node(NODES[1][0])}
        <div className="flink one" aria-hidden="true"><span /></div>
        {node(NODES[2][0])}
        <div className="flink one" aria-hidden="true"><span /></div>
        {node(NODES[3][0])}
      </div>
      <p className="flow-note small" aria-live="polite">{FLOW[k]}</p>
    </>
  );
}
