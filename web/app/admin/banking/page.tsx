"use client";

import { useState } from "react";
import { ConfirmButton, Dialog, Head, call, useAct, useData, useToast, when } from "@/components/admin/kit";

type B = { id: number; owner_type: string; owner_id: string; account_name: string; bank_name: string; country: string; currency: string; swift_bic: string | null; last4: string; status: string; updated_at: string };
const OWNER_TYPES = ["marina", "investor", "yacht_spv", "user", "platform"];

export default function Banking() {
  const { data, err, reload } = useData<B[]>("/admin/bank-accounts");
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [edit, setEdit] = useState<B | "new" | null>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    Object.keys(f).forEach((k) => { if (f[k] === "") delete f[k]; });
    const ok = edit === "new"
      ? await act(() => call("/admin/bank-accounts", { method: "POST", body: JSON.stringify(f) }), "Bank account added")
      : await act(() => call(`/admin/bank-accounts/${(edit as B).id}`, { method: "PATCH", body: JSON.stringify(f) }), "Bank account updated");
    if (ok) setEdit(null);
  }
  const cur = edit && edit !== "new" ? edit : null;

  return (
    <>
      <Head eyebrow="Money" title="Banking details"><button className="primary" onClick={() => setEdit("new")}>Add bank account</button></Head>
      <p className="banner small">Account numbers are encrypted when saved and are never shown again in full. Changing a number sends the account back to verification.</p>
      {err && <p className="err">{err}</p>}
      <div className="panel tbl">
        <table>
          <thead><tr><th>Owner</th><th>Account</th><th>Bank</th><th>Number</th><th>Status</th><th>Updated</th><th>Actions</th></tr></thead>
          <tbody>
            {data?.length ? data.map((b) => (
              <tr key={b.id}>
                <td><span className="pill">{b.owner_type}</span><br /><span className="mono small">{b.owner_id}</span></td>
                <td><b>{b.account_name}</b><br /><span className="small muted">{b.currency} · {b.country}</span></td>
                <td>{b.bank_name}<br /><span className="mono small muted">{b.swift_bic ?? "—"}</span></td>
                <td className="mono">•••• {b.last4}</td>
                <td><span className={`pill ${b.status === "verified" ? "ok" : b.status === "disabled" ? "crit" : "warn"}`}>{b.status.replace("_", " ")}</span></td>
                <td className="small">{when(b.updated_at)}</td>
                <td><div className="row" style={{ gap: 6 }}>
                  {b.status !== "verified" && <button className="sm primary" onClick={() => act(() => call(`/admin/bank-accounts/${b.id}`, { method: "PATCH", body: JSON.stringify({ status: "verified" }) }), "Marked verified")}>Verify</button>}
                  <button className="sm" onClick={() => setEdit(b)}>Edit</button>
                  <ConfirmButton label="Delete" confirm="Delete account" onConfirm={() => act(() => call(`/admin/bank-accounts/${b.id}`, { method: "DELETE" }), "Bank account deleted")} />
                </div></td>
              </tr>
            )) : <tr><td colSpan={7} className="muted">No bank accounts yet. Add the payout accounts for marinas, yacht SPVs and investors.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <Dialog title={cur ? `Edit account •••• ${cur.last4}` : "Add bank account"} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={save}>
            {!cur && <>
              <label className="f" htmlFor="ot">Owner type<select id="ot" name="owner_type">{OWNER_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="f" htmlFor="oi">Owner id<input id="oi" name="owner_id" required placeholder="MARINA-DXB-001" /></label>
            </>}
            <label className="f" htmlFor="an">Account name<input id="an" name="account_name" required={!cur} defaultValue={cur?.account_name} /></label>
            <label className="f" htmlFor="bn">Bank<input id="bn" name="bank_name" required={!cur} defaultValue={cur?.bank_name} /></label>
            <label className="f" htmlFor="co">Country<input id="co" name="country" required={!cur} defaultValue={cur?.country} /></label>
            <label className="f" htmlFor="cu">Currency<input id="cu" name="currency" maxLength={3} defaultValue={cur?.currency ?? "USD"} /></label>
            <label className="f" htmlFor="sw">SWIFT / BIC<input id="sw" name="swift_bic" className="mono" defaultValue={cur?.swift_bic ?? ""} /></label>
            <label className="f" htmlFor="nu">{cur ? "New account number (leave blank to keep)" : "IBAN or account number"}
              <input id="nu" name="account_number" className="mono" required={!cur} autoComplete="off" /></label>
            {cur && <label className="f" htmlFor="st">Status<select id="st" name="status" defaultValue={cur.status}><option value="pending_verification">Pending verification</option><option value="verified">Verified</option><option value="disabled">Disabled</option></select></label>}
            <button className="primary">{cur ? "Save changes" : "Add account"}</button>
          </form>
        </Dialog>
      )}
      {node}
    </>
  );
}
