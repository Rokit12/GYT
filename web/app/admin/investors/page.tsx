"use client";

import { useState } from "react";
import { ConfirmButton, Dialog, Head, call, useAct, useData, useToast } from "@/components/admin/kit";

type I = { id: string; name: string; kind: string; country_code: number; professional: boolean; wallet: string | null; kyc_status: string; screening: string; kyc_expires: string | null; deleted_at: string | null };

export default function Investors() {
  const { data, err, reload } = useData<I[]>("/investors");
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [edit, setEdit] = useState<I | "new" | null>(null);
  const cur = edit && edit !== "new" ? edit : null;
  const live = (data ?? []).filter((i) => !i.deleted_at);

  return (
    <>
      <Head eyebrow="People" title="Investors & KYC"><button className="primary" onClick={() => setEdit("new")}>Add investor</button></Head>
      {err && <p className="err">{err}</p>}
      <div className="panel tbl">
        <table>
          <thead><tr><th>Investor</th><th>Country</th><th>Category</th><th>Screening</th><th>KYC</th><th>Wallet</th><th>Actions</th></tr></thead>
          <tbody>
            {live.map((i) => (
              <tr key={i.id}>
                <td><b>{i.name}</b><br /><span className="mono small muted">{i.id} · {i.kind}</span></td>
                <td className="mono">{i.country_code}</td>
                <td>{i.professional ? "Professional" : "Retail"}</td>
                <td><span className={`pill ${i.screening === "clear" ? "ok" : i.screening === "sanctions_hit" ? "crit" : "warn"}`}>{i.screening.replace("_", " ")}</span></td>
                <td><span className={`pill ${i.kyc_status === "approved" ? "ok" : i.kyc_status === "rejected" ? "crit" : "warn"}`}>{i.kyc_status}</span>{i.kyc_expires && <><br /><span className="small muted">until {i.kyc_expires}</span></>}</td>
                <td className="mono small">{i.wallet ? `${i.wallet.slice(0, 8)}…${i.wallet.slice(-4)}` : "—"}</td>
                <td><div className="row" style={{ gap: 6 }}>
                  <button className="sm" onClick={() => act(() => call(`/investors/${i.id}/screen`, { method: "POST" }), `${i.name} re-screened`)}>Screen</button>
                  {i.kyc_status !== "approved" && <button className="sm primary" onClick={() => act(() => call(`/investors/${i.id}/kyc?status=approved`, { method: "POST" }), `${i.name} approved`)}>Approve KYC</button>}
                  {i.kyc_status === "pending" && <button className="sm" onClick={() => act(() => call(`/investors/${i.id}/kyc?status=rejected`, { method: "POST" }), `${i.name} rejected`)}>Reject</button>}
                  <button className="sm" onClick={() => setEdit(i)}>Edit</button>
                  <ConfirmButton label="Delete" confirm="Delete investor" onConfirm={() => act(() => call(`/admin/investors/${i.id}`, { method: "DELETE" }), `${i.name} deleted`)} />
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Dialog title={cur ? `Edit ${cur.name}` : "Add investor"} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body: Record<string, unknown> = { name: f.get("name"), country_code: Number(f.get("cc")), professional: f.get("pro") === "on" };
            if (f.get("wallet")) body.wallet = f.get("wallet");
            const ok = cur
              ? await act(() => call(`/admin/investors/${cur.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Investor updated")
              : await act(() => call("/admin/investors", { method: "POST", body: JSON.stringify({ ...body, id: f.get("id"), kind: f.get("kind") }) }), "Investor added");
            if (ok) setEdit(null);
          }}>
            {!cur && <>
              <label className="f" htmlFor="i1">Investor id<input id="i1" name="id" required placeholder="INV-2001" /></label>
              <label className="f" htmlFor="i2">Type<select id="i2" name="kind"><option value="entity">Entity</option><option value="individual">Individual</option></select></label>
            </>}
            <label className="f" htmlFor="i3">Name<input id="i3" name="name" required defaultValue={cur?.name} /></label>
            <label className="f" htmlFor="i4">Country (ISO numeric)<input id="i4" name="cc" type="number" required defaultValue={cur?.country_code} /></label>
            <label className="f" htmlFor="i5">Wallet address<input id="i5" name="wallet" className="mono" placeholder="0x…" defaultValue={cur?.wallet ?? ""} /></label>
            <label className="row small" htmlFor="i6"><input id="i6" name="pro" type="checkbox" defaultChecked={cur?.professional} style={{ width: "auto" }} /> Professional investor</label>
            <button className="primary">{cur ? "Save changes" : "Add investor"}</button>
          </form>
        </Dialog>
      )}
      {node}
    </>
  );
}
