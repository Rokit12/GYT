"use client";

import { useCallback, useEffect, useState } from "react";
import { call, usd, type Yacht } from "@/lib/api";

const SAMPLE = "INV-1043";

type Holding = { yacht_id: string; units: number; mode: "use" | "earn"; stake_usd: number; credits_usd: number };
type Summary = {
  stake_usd: number;
  use_credits_usd: number;
  use_credits_left_usd: number;
  earn_pool_usd: number;
  earn_payout_est_usd: number;
  holdings: Holding[];
};

export default function EarnClient({ investorId }: { investorId: string | null }) {
  const sample = !investorId;
  const INVESTOR = investorId ?? SAMPLE;
  const [sum, setSum] = useState<Summary | null>(null);
  const [yachts, setYachts] = useState<Yacht[]>([]);
  const [yachtId, setYachtId] = useState("YACHT-000003");
  const [arrive, setArrive] = useState(() => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10));
  const [nights, setNights] = useState(3);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setSum(await call<Summary>(`/investors/${INVESTOR}/earn`));
  }, []);
  useEffect(() => {
    load();
    call<Yacht[]>("/yachts").then(setYachts);
  }, [load]);

  const y = yachts.find((v) => v.id === yachtId);
  const nightly = y ? Number(y.charter_week_usd) / 7 : 0;
  const cost = nightly * 0.85 * nights;

  async function setMode(id: string, mode: "use" | "earn") {
    if (sample) return setMsg({ ok: false, text: "This is a sample wallet. Your own holdings appear here once an admin links your investor profile." });
    try {
      await call(`/investors/${INVESTOR}/holdings/${id}/mode`, { method: "PUT", body: JSON.stringify({ mode }) });
      setMsg(null);
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (sample) return setMsg({ ok: false, text: "Booking with credits needs your own holdings. This is a sample wallet." });
    const ref = `CS-${Date.now().toString().slice(-6)}`;
    try {
      const r = await call<{ credits_usd: number }>(`/investors/${INVESTOR}/stays`, {
        method: "POST",
        body: JSON.stringify({ ref, yacht_id: yachtId, arrive, nights }),
      });
      setMsg({ ok: true, text: `${ref} booked for ${usd(r.credits_usd)} in credits. Held in escrow until arrival is proven.` });
      load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  const name = (id: string) => yachts.find((v) => v.id === id)?.name ?? id;

  return (
    <>
      <div>
        <div className="eyebrow">Use or Earn{sample ? " · sample wallet" : ` · ${INVESTOR}`}</div>
        <h1>Use it, or earn from it</h1>
        <p className="lede">
          Each unit carries yearly usage credits worth 6% of your stake. Spend them on nights aboard any verified yacht at 85% of
          the public rate, or pool them and get paid when guests book. Payment releases only on proven arrival.
        </p>
      </div>
      {sample && (
        <p className="banner">You don&apos;t hold units yet, so this shows a sample wallet. Once you invest through a licensed partner and an
          admin links your investor profile, your own holdings and credits appear here.</p>
      )}
      <div className="grid g4">
        <div className="panel kpi"><div className="l">Portfolio stake</div><div className="v">{usd(sum?.stake_usd, true)}</div></div>
        <div className="panel kpi"><div className="l">Use credits left</div><div className="v">{usd(sum?.use_credits_left_usd, true)}</div><div className="d">of {usd(sum?.use_credits_usd)}</div></div>
        <div className="panel kpi"><div className="l">Earn pool</div><div className="v">{usd(sum?.earn_pool_usd, true)}</div></div>
        <div className="panel kpi"><div className="l">Est. earn payout</div><div className="v">{usd(sum?.earn_payout_est_usd, true)}</div><div className="d">at 70% occupancy</div></div>
      </div>
      <div className="grid g2">
        <div className="panel">
          <header><h3>Your holdings</h3></header>
          <div className="tbl">
            <table>
              <thead><tr><th>Yacht</th><th className="r">Units</th><th className="r">Stake</th><th className="r">Credits</th><th>Mode</th></tr></thead>
              <tbody>
                {sum?.holdings.map((h) => (
                  <tr key={h.yacht_id}>
                    <td><b>{name(h.yacht_id)}</b><br /><span className="mono small muted">{h.yacht_id}</span></td>
                    <td className="r">{h.units.toLocaleString()}</td>
                    <td className="r">{usd(h.stake_usd, true)}</td>
                    <td className="r">{usd(h.credits_usd)}</td>
                    <td>
                      <span className="seg" role="group" aria-label={`Mode for ${name(h.yacht_id)}`}>
                        {(["use", "earn"] as const).map((m) => (
                          <button key={m} aria-pressed={h.mode === m} onClick={() => setMode(h.yacht_id, m)}>
                            {m === "use" ? "Use" : "Earn"}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <header><h3>Spend credits on any yacht</h3><span className="pill">Cross-fleet</span></header>
          <form className="form" onSubmit={book}>
            <label className="f" htmlFor="y">Yacht
              <select id="y" value={yachtId} onChange={(e) => setYachtId(e.target.value)}>
                {yachts.map((v) => (
                  <option key={v.id} value={v.id} disabled={!v.insurance_verified}>
                    {v.name} · {Number(v.loa_m)} m{v.insurance_verified ? "" : " (insurance not verified)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="f" htmlFor="a">Start<input id="a" type="date" value={arrive} onChange={(e) => setArrive(e.target.value)} /></label>
            <label className="f" htmlFor="n">Nights<input id="n" type="number" min={1} max={14} value={nights} onChange={(e) => setNights(Math.max(1, Math.min(14, +e.target.value || 1)))} /></label>
            <button className="primary" type="submit">Book with credits</button>
          </form>
          <div style={{ marginTop: 10 }}>
            <div className="kv"><span>Public nightly rate</span><span className="mono">{usd(nightly)}</span></div>
            <div className="kv"><span>Credits needed (85%)</span><span className="mono">{usd(cost)}</span></div>
            <div className="kv"><span>Departs from</span><span>{y?.marina_name ?? "—"}</span></div>
          </div>
          {msg && <p className={msg.ok ? "small" : "err"} role="status">{msg.text}</p>}
        </div>
      </div>
    </>
  );
}
