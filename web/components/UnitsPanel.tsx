"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Holder = { label: string; kind: string; professional: boolean; units: number; pct: number; mode: string; value_usd: number | null; you: boolean };
type Units = {
  name: string; tokenized: boolean; contract: string | null; units_total: number; units_minted: number; units_held: number; units_available: number;
  valuation_usd: number | null; unit_price_usd: number | null; unit_share_pct: number | null; holders: Holder[]; holder_count: number;
  history: { date: string; value_usd: number; unit_price_usd: number | null; source: string }[];
};
const usd = (n: number | null | undefined, d = 0) => n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const big = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : usd(n);
const fmtDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", year: "2-digit" });

/** Unit price history: one series, so no legend; crosshair + tooltip on hover or keyboard. */
function PriceChart({ h }: { h: Units["history"] }) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 560, H = 200, L = 52, R = 14, T = 14, B = 26;
  const pts = h.filter((x) => x.unit_price_usd != null);
  if (pts.length < 2) return null;
  const ys = pts.map((p) => p.unit_price_usd!);
  const lo = Math.min(...ys) * 0.97, hiV = Math.max(...ys) * 1.02;
  const X = (i: number) => L + (i / (pts.length - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hiV - lo)) * (H - T - B);
  const ticks = [lo, (lo + hiV) / 2, hiV];
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.unit_price_usd!).toFixed(1)}`).join("");
  const area = `${path}L${X(pts.length - 1)},${H - B}L${X(0)},${H - B}Z`;
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W;
    setHi(Math.max(0, Math.min(pts.length - 1, Math.round(((x - L) / (W - L - R)) * (pts.length - 1)))));
  };
  const p = hi != null ? pts[hi] : null;
  return (
    <div className="pchart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Unit price over ${pts.length} valuations, from ${usd(ys[0])} to ${usd(ys.at(-1))}`}
        onPointerMove={move} onPointerLeave={() => setHi(null)} tabIndex={0}
        onKeyDown={(e) => { if (e.key === "ArrowRight") setHi(Math.min(pts.length - 1, (hi ?? -1) + 1)); if (e.key === "ArrowLeft") setHi(Math.max(0, (hi ?? pts.length) - 1)); }}>
        <defs><linearGradient id="pfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth="1" /><text x={L - 8} y={Y(t) + 4} textAnchor="end" className="ax">{usd(t)}</text></g>)}
        <text x={L} y={H - 6} className="ax">{fmtDate(pts[0].date)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="ax">{fmtDate(pts.at(-1)!.date)}</text>
        <path d={area} fill="url(#pfill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((q, i) => <circle key={q.date} cx={X(i)} cy={Y(q.unit_price_usd!)} r={i === hi || i === pts.length - 1 ? 5 : 3} fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />)}
        {p && <line x1={X(hi!)} x2={X(hi!)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="3 3" />}
      </svg>
      {p && (
        <div className="ptip" style={{ left: `${(X(hi!) / W) * 100}%` }}>
          <b>{usd(p.unit_price_usd, 2)}</b><span>per unit · {new Date(p.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
          <span>Valuation {big(p.value_usd)} · {p.source}</span>
        </div>
      )}
    </div>
  );
}

export default function UnitsPanel({ yachtId }: { yachtId: string }) {
  const [u, setU] = useState<Units | null>(null);
  const [n, setN] = useState(100);
  const [tip, setTip] = useState<{ h: Holder; x: number } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => { fetch(`/api/gyt/yachts/${yachtId}/units`, { cache: "no-store" }).then((r) => r.json()).then(setU).catch(() => {}); }, [yachtId]);
  const change = useMemo(() => {
    const h = u?.history.filter((x) => x.unit_price_usd) ?? [];
    return h.length > 1 ? ((h.at(-1)!.unit_price_usd! / h[0].unit_price_usd! - 1) * 100) : null;
  }, [u]);

  if (!u) return <div className="panel" id="units"><div className="skel" style={{ height: 160 }} /></div>;
  if (!u.tokenized || !u.unit_price_usd) {
    return (
      <div className="panel" id="units">
        <header><h3>Units &amp; ownership</h3><span className="pill">No units issued</span></header>
        <p className="small muted">This yacht has a verified passport and tracking, but its owner has not issued ownership units. Follow it to hear if that changes.</p>
      </div>
    );
  }
  const max = Math.max(1, Math.min(u.units_available || u.units_total, Math.round(u.units_total * 0.02)));
  const k = Math.min(n, max);
  return (
    <div className="panel units" id="units">
      <header><h3>Units &amp; ownership</h3><span className="small muted">{u.holder_count} holder{u.holder_count === 1 ? "" : "s"} · permissioned token{u.contract ? ` ${u.contract.slice(0, 8)}…` : ""}</span></header>

      <div className="u-hero">
        <div className="u-price">
          <span className="eyebrow">1 unit equals</span>
          <b>{usd(u.unit_price_usd, 2)}</b>
          <span className="small">{u.unit_share_pct}% of {u.name}{change != null && <> · <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%</span> over {u.history.length - 1} quarters</>}</span>
        </div>
        <div className="u-eq" aria-label="How the unit price is calculated">
          <div><span className="small muted">Latest valuation</span><b>{big(u.valuation_usd!)}</b></div>
          <span className="op">÷</span>
          <div><span className="small muted">Units issued</span><b>{u.units_total.toLocaleString()}</b></div>
          <span className="op">=</span>
          <div><span className="small muted">Per unit</span><b>{usd(u.unit_price_usd, 2)}</b></div>
        </div>
      </div>

      <div className="u-calc">
        <label className="f" htmlFor="u-n">If you held <output className="mono">{k.toLocaleString()}</output> units
          <input id="u-n" type="range" min={1} max={max} step={1} value={k} onChange={(e) => setN(+e.target.value)} />
        </label>
        <div className="u-calc-out"><div><span className="small muted">Indicative value</span><b>{usd(k * u.unit_price_usd)}</b></div>
          <div><span className="small muted">Share of the yacht</span><b>{((k / u.units_total) * 100).toFixed(4)}%</b></div></div>
        <p className="small muted" style={{ margin: 0 }}>Slider stops at {max.toLocaleString()} units, the 2% retail limit for one yacht. Professional investors can hold up to 25%.</p>
      </div>

      <div className="u-own">
        <div className="row" style={{ justifyContent: "space-between" }}><b className="small">Who holds the units</b>
          <span className="small muted">{((u.units_held / u.units_total) * 100).toFixed(1)}% held · {u.units_available.toLocaleString()} available</span></div>
        <div className="u-bar" ref={bar} onPointerLeave={() => setTip(null)} role="img"
          aria-label={`${u.units_held.toLocaleString()} of ${u.units_total.toLocaleString()} units held by ${u.holder_count} holders`}>
          {u.holders.map((h) => (
            <span key={h.label} className={`seg ${h.you ? "you" : ""}`} style={{ flexGrow: h.units }}
              onPointerEnter={(e) => { const r = bar.current!.getBoundingClientRect(), s = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTip({ h, x: s.left - r.left + s.width / 2 }); }} />
          ))}
          <span className="seg avail" style={{ flexGrow: u.units_available }} />
          {tip && <span className="u-tip" style={{ left: tip.x }}><b>{tip.h.label}{tip.h.you ? " (you)" : ""}</b><span>{tip.h.units.toLocaleString()} units · {tip.h.pct}% · {usd(tip.h.value_usd)}</span></span>}
        </div>
        <div className="u-legend small"><span><i className="sw held" />Held</span><span><i className="sw you" />You</span><span><i className="sw avail" />Available to eligible investors</span></div>
        <div className="tbl"><table>
          <thead><tr><th>Holder</th><th>Type</th><th className="r">Units</th><th className="r">Share</th><th className="r">Value</th><th>This year</th></tr></thead>
          <tbody>{u.holders.map((h) => (
            <tr key={h.label} className={h.you ? "me" : ""}>
              <td className="mono">{h.label}{h.you && <span className="pill ok" style={{ marginLeft: 6 }}>You</span>}</td>
              <td>{h.kind === "entity" ? "Company" : "Individual"}{h.professional ? " · professional" : ""}</td>
              <td className="r">{h.units.toLocaleString()}</td>
              <td className="r"><span className="mini"><i style={{ width: `${Math.min(100, h.pct * 4)}%` }} /></span>{h.pct}%</td>
              <td className="r">{usd(h.value_usd)}</td><td>{h.mode === "earn" ? "Earning" : "Using"}</td>
            </tr>))}
            <tr className="avail-row"><td>Available</td><td className="muted">Unallocated</td><td className="r">{u.units_available.toLocaleString()}</td>
              <td className="r">{((u.units_available / u.units_total) * 100).toFixed(1)}%</td><td className="r">{usd(u.units_available * u.unit_price_usd)}</td><td /></tr>
          </tbody>
        </table></div>
        <p className="small muted">Holders are shown by wallet or number, never by name. Your own holding is highlighted when you are signed in.</p>
      </div>

      <div className="u-hist">
        <b className="small">Unit price after each valuation</b>
        <PriceChart h={u.history} />
      </div>

      <details className="u-explain">
        <summary>How one unit is priced</summary>
        <ul>
          <li>Each yacht is owned by its own company. That company issued <b>{u.units_total.toLocaleString()}</b> equal units, so one unit is <b>{u.unit_share_pct}%</b> of the yacht.</li>
          <li>The indicative price is the latest independent valuation divided by the number of units. It changes only when a new valuation is recorded.</li>
          <li>It is not a market quote. Units move only between eligible holders, and nobody is obliged to buy or sell at this price.</li>
        </ul>
      </details>
    </div>
  );
}
