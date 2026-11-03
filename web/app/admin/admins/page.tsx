"use client";

import { useState } from "react";
import { ConfirmButton, Dialog, Head, call, useAct, useData, useToast, when } from "@/components/admin/kit";
import { useAdminMe } from "@/components/admin/useAdminMe";

type A = { id: number; email: string; name: string; status: string; is_primary: boolean; rights: string[]; created_at: string; last_login_at: string | null };

function RightsPicker({ all, value, onChange }: { all: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="rights-pick">
      <legend className="small muted">Rights</legend>
      {all.map((r) => (
        <label key={r.key} className="check">
          <input type="checkbox" checked={value.includes(r.key)} onChange={(e) => onChange(e.target.checked ? [...value, r.key] : value.filter((x) => x !== r.key))} />
          {r.label}
        </label>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="sm" onClick={() => onChange(all.map((r) => r.key))}>All</button>
        <button type="button" className="sm" onClick={() => onChange([])}>None</button>
      </div>
    </fieldset>
  );
}

export default function Admins() {
  const me = useAdminMe();
  const { data, err, reload } = useData<A[]>("/admin/admins");
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<A | null>(null);
  const [rights, setRights] = useState<string[]>([]);
  const [created, setCreated] = useState<{ email: string; pw: string } | null>(null);
  const all = me?.rights ?? [];
  const label = (k: string) => all.find((r) => r.key === k)?.label ?? k;

  return (
    <>
      <Head eyebrow="People" title="Admins & rights">
        <button className="primary" onClick={() => { setRights([]); setAdding(true); }}>Add an admin</button>
      </Head>
      <p className="small muted" style={{ maxWidth: 760 }}>
        The <b>primary admin</b> has every right and can&apos;t be deleted, suspended or demoted. Secondary admins see and do only
        what their rights allow; a change takes effect at once, without them signing out. Only the primary admin can manage admins.
      </p>
      {err && <p className="err">{err}</p>}
      {created && (
        <div className="panel" role="status">
          <b>Admin account created for {created.email}.</b> Give them this temporary password privately; it is shown only once and
          they should change it in Settings after signing in:
          <p className="mono" style={{ fontSize: 18, margin: "8px 0" }}>{created.pw}</p>
          <button className="sm" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}
      <div className="panel tbl">
        <table>
          <thead><tr><th>Admin</th><th>Rights</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id}>
                <td><b>{a.name}</b>{a.is_primary && <> <span className="pill ok">Primary</span></>}<br /><span className="small muted">{a.email}</span></td>
                <td className="small">{a.is_primary ? "Every right" : a.rights.length ? a.rights.map(label).join(" · ") : <span className="muted">No rights yet</span>}</td>
                <td><span className={`pill ${a.status === "active" ? "ok" : "crit"}`}>{a.status}</span></td>
                <td className="small">{when(a.last_login_at)}</td>
                <td>
                  {a.is_primary ? <span className="small muted">Can&apos;t be changed</span> : (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="sm" onClick={() => { setRights(a.rights); setEdit(a); }}>Edit rights</button>
                      {a.status === "active"
                        ? <button className="sm" onClick={() => act(() => call(`/admin/admins/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) }), `${a.name} suspended`)}>Suspend</button>
                        : <button className="sm" onClick={() => act(() => call(`/admin/admins/${a.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }), `${a.name} reactivated`)}>Reactivate</button>}
                      <ConfirmButton label="Remove admin" confirm="Remove admin access" onConfirm={() => act(() => call(`/admin/admins/${a.id}`, { method: "DELETE" }), `${a.name} is no longer an admin`)} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Dialog title="Add an admin" onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const email = String(f.get("email")).trim();
            const ok = await act(async () => {
              const r = await call<A & { temporary_password?: string }>("/admin/admins", { method: "POST", body: JSON.stringify({ email, name: String(f.get("name") || "").trim() || null, rights }) });
              if (r.temporary_password) setCreated({ email, pw: r.temporary_password });
              return r;
            }, `${email} is now an admin`);
            if (ok) setAdding(false);
          }}>
            <label className="f" htmlFor="ae">Email<input id="ae" name="email" type="email" required autoComplete="off" /></label>
            <label className="f" htmlFor="an">Full name (for a new account)<input id="an" name="name" autoComplete="off" /></label>
            <p className="small muted" style={{ margin: 0 }}>If the email already has a GYT account, it becomes an admin. Otherwise a new account is created with a temporary password.</p>
            <RightsPicker all={all} value={rights} onChange={setRights} />
            <button className="primary">Add admin</button>
          </form>
        </Dialog>
      )}
      {edit && (
        <Dialog title={`Rights for ${edit.name}`} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            if (await act(() => call(`/admin/admins/${edit.id}`, { method: "PATCH", body: JSON.stringify({ rights }) }), `Rights updated for ${edit.name}`)) setEdit(null);
          }}>
            <RightsPicker all={all} value={rights} onChange={setRights} />
            <button className="primary">Save rights</button>
          </form>
        </Dialog>
      )}
      {node}
    </>
  );
}
