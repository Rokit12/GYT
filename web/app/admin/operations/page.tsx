"use client";

import { useCallback, useEffect, useState } from "react";
import { usd } from "@/lib/api";
import { ConfirmButton, Head, call } from "@/components/admin/kit";

type Booking = { ref: string; kind: string; yacht: string; marina: string; berth: string | null; arrive: string; amount_usd: string; status: string };
type Anchor = { id: number; root: string; leaf_count: number; created_at: string; chain_tx: string | null };
type Investor = { id: string; name: string; country_code: number; kyc_status: string; screening: string };
type Signal = { source: string; present: boolean; ok: boolean; distance_to_target_m: number | null; note: string };
type Check = { rule: string; ok: boolean; detail: string };

export default function Operations() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [signals, setSignals] = useState<Record<string, { arrived: boolean; signals: Signal[]; reasons: string[] }>>({});
  const [msg, setMsg] = useState("");
  const [tx, setTx] = useState({ investor_id: "INV-1043", yacht_id: "YACHT-000001", units: 500 });
  const [checks, setChecks] = useState<{ allowed: boolean; checks: Check[] } | null>(null);

  const load = useCallback(async () => {
    const [b, a, i] = await Promise.all([
      call<Booking[]>("/bookings"),
      call<Anchor[]>("/anchors"),
      call<Investor[]>("/investors"),
    ]);
    setBookings(b);
    setAnchors(a);
    setInvestors(i);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg(ok);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <>
      <Head eyebrow="Operations" title="Bookings & escrow" />
      {msg && <p className="banner small" role="status">{msg}</p>}

      <div className="panel">
        <header><h3>Bookings &amp; arrival escrow</h3><span className="small muted">Prove arrival → anchor → release</span></header>
        <div className="tbl">
          <table>
            <thead><tr><th>Ref</th><th>Yacht</th><th>Where</th><th>Arrive</th><th className="r">Held</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.ref}>
                  <td className="mono">{b.ref}</td><td>{b.yacht}</td><td>{b.marina} {b.berth && <span className="mono small">{b.berth}</span>}</td>
                  <td className="mono small">{b.arrive}</td><td className="r">{usd(b.amount_usd)}</td>
                  <td><span className={`pill ${b.status === "released" ? "ok" : b.status === "arrived" ? "" : "warn"}`}>{b.status}</span></td>
                  <td>
                    <div className="row">
                      {b.status === "escrowed" && (
                        <button onClick={async () => {
                          try {
                            const r = await call<{ arrived: boolean; signals: Signal[]; reasons: string[] }>(`/bookings/${b.ref}/arrival`, { method: "POST" });
                            setSignals({ ...signals, [b.ref]: r });
                            setMsg(r.arrived ? `${b.ref}: arrival proven` : `${b.ref}: not proven (${r.reasons.join(", ")})`);
                            load();
                          } catch (e) { setMsg((e as Error).message); }
                        }}>Prove arrival</button>
                      )}
                      {b.status === "escrowed" && (
                        <ConfirmButton label="Cancel & refund" confirm="Refund payer" onConfirm={() => act(() => call(`/admin/bookings/${b.ref}/cancel`, { method: "POST" }), `${b.ref} cancelled and refunded`)} />
                      )}
                      {b.status === "arrived" && (
                        <button className="primary" onClick={() => act(() => call(`/bookings/${b.ref}/release`, { method: "POST" }), `${b.ref} released`)}>Release</button>
                      )}
                    </div>
                    {signals[b.ref] && (
                      <div className="sig" style={{ marginTop: 8 }}>
                        {signals[b.ref].signals.map((s) => (
                          <div key={s.source} className={s.ok ? "ok" : ""}>
                            <b>{s.ok ? "✓ " : ""}{s.source.toUpperCase()}</b><br />
                            {s.present ? `${Math.round(s.distance_to_target_m ?? 0)} m from berth` : s.note}
                            {s.present && s.note ? ` · ${s.note}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <header><h3>Anchors</h3><button onClick={() => act(() => call("/anchors", { method: "POST" }), "Pending events anchored")}>Anchor now</button></header>
          <div className="tbl">
            <table>
              <thead><tr><th>#</th><th className="r">Events</th><th>Root</th><th>Chain tx</th></tr></thead>
              <tbody>
                {anchors.map((a) => (
                  <tr key={a.id}><td className="mono">{a.id}</td><td className="r">{a.leaf_count}</td>
                    <td className="mono small">{a.root.slice(0, 14)}…</td><td className="mono small">{a.chain_tx ? `${a.chain_tx.slice(0, 12)}…` : "off-chain"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <header><h3>Transfer policy engine</h3></header>
          <form className="form" onSubmit={async (e) => { e.preventDefault(); setChecks(await call("/compliance/check-transfer", { method: "POST", body: JSON.stringify(tx) })); }}>
            <label className="f" htmlFor="inv">Buyer
              <select id="inv" value={tx.investor_id} onChange={(e) => setTx({ ...tx, investor_id: e.target.value })}>
                {investors.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.kyc_status})</option>)}
              </select>
            </label>
            <label className="f" htmlFor="u">Units<input id="u" type="number" value={tx.units} onChange={(e) => setTx({ ...tx, units: +e.target.value })} /></label>
            <button className="primary" type="submit">Run checks</button>
          </form>
          {checks && (
            <div className="check" style={{ marginTop: 10 }}>
              {checks.checks.map((c) => (
                <div key={c.rule}><span style={{ color: `var(--${c.ok ? "ok" : "crit"})` }}>{c.ok ? "✓" : "✕"}</span><b>{c.rule}</b> <span className="muted small">{c.detail}</span></div>
              ))}
              <span className={`pill ${checks.allowed ? "ok" : "crit"}`}>{checks.allowed ? "Allowed: on-chain check runs at transfer" : "Blocked before chain"}</span>
            </div>
          )}
        </div>
      </div>

    </>
  );
}
