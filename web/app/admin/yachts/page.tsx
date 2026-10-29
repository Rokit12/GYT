"use client";

import { useState } from "react";
import { usd } from "@/lib/api";
import { ConfirmButton, Dialog, Head, call, short, useAct, useData, useToast } from "@/components/admin/kit";

type Y = {
  id: string; name: string; flag: string; loa_m: string; beam_m: string; marina_name: string; home_marina_id: string; berth_code: string | null;
  valuation_usd: string | null; charter_week_usd: string | null; units_total: number; units_minted: number; units_held: number;
  twin_status: "pending" | "verified" | "minted" | "retired"; twin_token_id: number | null; twin_tx: string | null; docs_root: string | null;
  insurance_verified: boolean; inspection_status: string; retired_at: string | null;
};
type Comp = { allowed_countries: number[]; professional_max_bps: number; retail_max_bps: number; lockup_until: string | null };

const STAGES = ["pending", "verified", "minted"] as const;

export default function YachtsAdmin() {
  const { data, err, reload } = useData<Y[]>("/admin/yachts");
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [edit, setEdit] = useState<Y | null>(null);
  const [mint, setMint] = useState<Y | null>(null);
  const [comp, setComp] = useState<{ y: Y; c: Comp } | null>(null);
  const [view, setView] = useState<"all" | "queue">("all");
  const list = (data ?? []).filter((y) => view === "all" || ["pending", "verified"].includes(y.twin_status));

  async function openComp(y: Y) {
    try { setComp({ y, c: await call<Comp>(`/admin/yachts/${y.id}/compliance`) }); } catch (e) { show(false, (e as Error).message); }
  }

  return (
    <>
      <Head eyebrow="Registry" title="Yachts & minting">
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>All yachts</button>
          <button aria-pressed={view === "queue"} onClick={() => setView("queue")}>Mint queue ({(data ?? []).filter((y) => ["pending", "verified"].includes(y.twin_status)).length})</button>
        </div>
      </Head>
      {err && <p className="err">{err}</p>}
      <div className="cards">
        {list.map((y) => (
          <article key={y.id} className={`panel ycard ${y.retired_at ? "retired" : ""}`}>
            <header>
              <div><span className="eyebrow">{y.id}</span><h3>{y.name}</h3><span className="small muted">{Number(y.loa_m)} m · {y.flag} · {y.marina_name}</span></div>
              <span className={`pill ${y.twin_status === "minted" ? "ok" : y.twin_status === "retired" ? "crit" : "warn"}`}>{y.twin_status}</span>
            </header>
            {y.twin_status !== "retired" && (
              <ol className="stages" aria-label="Minting progress">
                {STAGES.map((s) => <li key={s} className={STAGES.indexOf(s) <= STAGES.indexOf(y.twin_status as typeof STAGES[number]) ? "done" : ""}>{s === "pending" ? "Submitted" : s === "verified" ? "Verified" : "Minted"}</li>)}
              </ol>
            )}
            <div className="kv"><span>Twin token</span><span className="mono small">{y.twin_token_id ? `#${y.twin_token_id}` : "—"}</span></div>
            <div className="kv"><span>Mint tx</span><span className="mono small" title={y.twin_tx ?? ""}>{short(y.twin_tx)}</span></div>
            <div className="kv"><span>Documents root</span><span className="mono small" title={y.docs_root ?? ""}>{short(y.docs_root)}</span></div>
            <div className="kv"><span>Units minted</span><span className="mono small">{y.units_minted.toLocaleString()} / {y.units_total.toLocaleString()}</span></div>
            <div className="kv"><span>Valuation</span><span>{usd(y.valuation_usd, true)}</span></div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {y.twin_status === "pending" && <button className="sm primary" onClick={() => act(() => call(`/admin/yachts/${y.id}/verify`, { method: "POST" }), `${y.name} verified`)}>Approve verification</button>}
              {y.twin_status === "verified" && <button className="sm primary" onClick={() => act(async () => {
                const r = await call<{ tx_hash: string | null; token_id: number }>(`/admin/yachts/${y.id}/mint-twin`, { method: "POST" });
                show(true, r.tx_hash ? `Minted twin #${r.token_id} · tx ${r.tx_hash.slice(0, 14)}…` : `Minted twin #${r.token_id} (off-chain)`);
              }, `${y.name} minted`)}>Mint twin</button>}
              {y.twin_status === "minted" && y.units_total > y.units_minted && <button className="sm primary" onClick={() => setMint(y)}>Issue units</button>}
              {!y.retired_at && <>
                <button className="sm" onClick={() => setEdit(y)}>Edit</button>
                <button className="sm" onClick={() => openComp(y)}>Compliance</button>
                <ConfirmButton label="Retire" confirm="Retire yacht" onConfirm={() => act(() => call(`/admin/yachts/${y.id}`, { method: "DELETE" }), `${y.name} retired`)} />
              </>}
            </div>
          </article>
        ))}
      </div>

      {edit && (
        <Dialog title={`Edit ${edit.name}`} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const num = (k: string) => (f.get(k) === "" ? undefined : Number(f.get(k)));
            const body = {
              name: f.get("name"), flag: f.get("flag"), loa_m: num("loa_m"), beam_m: num("beam_m"), berth_code: f.get("berth_code") || null,
              valuation_usd: num("valuation_usd"), charter_week_usd: num("charter_week_usd"), units_total: num("units_total"),
              insurance_verified: f.get("ins") === "on", inspection_status: f.get("insp"),
            };
            if (await act(() => call(`/admin/yachts/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Yacht updated")) setEdit(null);
          }}>
            <label className="f" htmlFor="e1">Name<input id="e1" name="name" defaultValue={edit.name} /></label>
            <label className="f" htmlFor="e2">Flag<input id="e2" name="flag" defaultValue={edit.flag} /></label>
            <label className="f" htmlFor="e3">Length (m)<input id="e3" name="loa_m" type="number" step="0.1" defaultValue={Number(edit.loa_m)} /></label>
            <label className="f" htmlFor="e4">Beam (m)<input id="e4" name="beam_m" type="number" step="0.1" defaultValue={Number(edit.beam_m)} /></label>
            <label className="f" htmlFor="e5">Berth<input id="e5" name="berth_code" defaultValue={edit.berth_code ?? ""} /></label>
            <label className="f" htmlFor="e6">Valuation (USD)<input id="e6" name="valuation_usd" type="number" defaultValue={Number(edit.valuation_usd ?? 0)} /></label>
            <label className="f" htmlFor="e7">Charter per week (USD)<input id="e7" name="charter_week_usd" type="number" defaultValue={Number(edit.charter_week_usd ?? 0)} /></label>
            <label className="f" htmlFor="e8">Units total<input id="e8" name="units_total" type="number" defaultValue={edit.units_total} /></label>
            <label className="f" htmlFor="e9">Inspection<select id="e9" name="insp" defaultValue={edit.inspection_status}>{["VALID", "PENDING", "DUE_30D", "EXPIRED"].map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="row small" htmlFor="e10"><input id="e10" name="ins" type="checkbox" defaultChecked={edit.insurance_verified} style={{ width: "auto" }} /> Insurance verified</label>
            <button className="primary">Save changes</button>
          </form>
        </Dialog>
      )}

      {mint && (
        <Dialog title={`Issue units · ${mint.name}`} onClose={() => setMint(null)}>
          <p className="small muted">{(mint.units_total - mint.units_minted).toLocaleString()} units left to issue. The compliance rules for this yacht run before anything is minted.</p>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (await act(() => call(`/admin/yachts/${mint.id}/mint-units`, { method: "POST", body: JSON.stringify({ investor_id: f.get("inv"), units: Number(f.get("units")) }) }), "Units issued")) setMint(null);
          }}>
            <label className="f" htmlFor="m1">Investor id<input id="m1" name="inv" required placeholder="INV-1045" /></label>
            <label className="f" htmlFor="m2">Units<input id="m2" name="units" type="number" min={1} required /></label>
            <button className="primary">Issue units</button>
          </form>
        </Dialog>
      )}

      {comp && (
        <Dialog title={`Compliance rules · ${comp.y.name}`} onClose={() => setComp(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = {
              allowed_countries: String(f.get("c")).split(/[\s,]+/).filter(Boolean).map(Number),
              professional_max_bps: Math.round(Number(f.get("p")) * 100), retail_max_bps: Math.round(Number(f.get("r")) * 100),
              lockup_until: f.get("l") ? new Date(String(f.get("l"))).toISOString() : null,
            };
            if (await act(() => call(`/admin/yachts/${comp.y.id}/compliance`, { method: "PUT", body: JSON.stringify(body) }), "Compliance rules saved")) setComp(null);
          }}>
            <label className="f" htmlFor="c1">Allowed countries (ISO numeric, comma separated)<input id="c1" name="c" className="mono" defaultValue={comp.c.allowed_countries.join(", ")} /></label>
            <label className="f" htmlFor="c2">Professional cap (% of supply)<input id="c2" name="p" type="number" step="0.01" defaultValue={comp.c.professional_max_bps / 100} /></label>
            <label className="f" htmlFor="c3">Retail cap (% of supply)<input id="c3" name="r" type="number" step="0.01" defaultValue={comp.c.retail_max_bps / 100} /></label>
            <label className="f" htmlFor="c4">Lock-up until<input id="c4" name="l" type="date" defaultValue={comp.c.lockup_until?.slice(0, 10) ?? ""} /></label>
            <button className="primary">Save rules</button>
          </form>
          <p className="small muted">These mirror the on-chain Compliance contract for this yacht&apos;s units.</p>
        </Dialog>
      )}
      {node}
    </>
  );
}
