"use client";

import { useState } from "react";
import Link from "next/link";
import { ConfirmButton, Dialog, Head, call, useAct, useData, useToast, when } from "@/components/admin/kit";

type U = { id: number; email: string; name: string; role: string; status: string; is_primary?: boolean; investor_id: string | null; wallet_address: string | null; created_at: string; last_login_at: string | null };

export default function Users() {
  const [filter, setFilter] = useState("");
  const { data, err, reload } = useData<U[]>(`/admin/users${filter ? `?status=${filter}` : ""}`);
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [edit, setEdit] = useState<U | null>(null);
  const patch = (u: U, body: object, ok: string) => act(() => call(`/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify(body) }), ok);

  return (
    <>
      <Head eyebrow="People" title="Users & approvals">
        <div className="seg" role="group" aria-label="Filter">
          {[["", "All"], ["pending", "Pending"], ["active", "Active"], ["suspended", "Suspended"]].map(([v, l]) => (
            <button key={v} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>
      </Head>
      {err && <p className="err">{err}</p>}
      <div className="panel tbl">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Investor</th><th>Last sign-in</th><th>Actions</th></tr></thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b><br /><span className="small muted">{u.email}</span></td>
                <td><span className={`pill ${u.role === "admin" ? "warn" : ""}`}>{u.is_primary ? "primary admin" : u.role}</span></td>
                <td><span className={`pill ${u.status === "active" ? "ok" : u.status === "pending" ? "warn" : "crit"}`}>{u.status}</span></td>
                <td className="mono small">{u.investor_id ?? "—"}</td>
                <td className="small">{when(u.last_login_at)}</td>
                <td>
                  {u.role === "admin" ? <Link className="small" href="/admin/admins">{u.is_primary ? "Primary admin: can't be changed" : "Manage in Admins & rights"}</Link> : <div className="row" style={{ gap: 6 }}>
                    {u.status === "pending" && <button className="sm primary" onClick={() => patch(u, { status: "active" }, `${u.name} approved`)}>Approve</button>}
                    {u.status === "active" && <button className="sm" onClick={() => patch(u, { status: "suspended" }, `${u.name} suspended`)}>Suspend</button>}
                    {u.status === "suspended" && <button className="sm" onClick={() => patch(u, { status: "active" }, `${u.name} reactivated`)}>Reactivate</button>}
                    <button className="sm" onClick={() => setEdit(u)}>Edit</button>
                    <ConfirmButton label="Delete" confirm="Delete user" onConfirm={() => act(() => call(`/admin/users/${u.id}`, { method: "DELETE" }), `${u.email} deleted`)} />
                  </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Dialog title={`Edit ${edit.name}`} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body: Record<string, string | null> = { name: String(f.get("name")) };
            body.investor_id = String(f.get("investor_id") || "") || null;
            const w = String(f.get("wallet") || "");
            if (w) body.wallet_address = w;
            if (await patch(edit, body, "User updated")) setEdit(null);
          }}>
            <label className="f" htmlFor="un">Name<input id="un" name="name" defaultValue={edit.name} /></label>
            <p className="small muted" style={{ margin: 0 }}>To make someone an admin, the primary admin uses <Link href="/admin/admins">Admins &amp; rights</Link>.</p>
            <label className="f" htmlFor="ui">Linked investor profile<input id="ui" name="investor_id" placeholder="INV-1043" defaultValue={edit.investor_id ?? ""} /></label>
            <label className="f" htmlFor="uw">Wallet address<input id="uw" name="wallet" className="mono" placeholder="0x…" defaultValue={edit.wallet_address ?? ""} /></label>
            <button className="primary">Save changes</button>
          </form>
        </Dialog>
      )}
      {node}
    </>
  );
}
