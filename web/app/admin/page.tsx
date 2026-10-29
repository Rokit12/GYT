"use client";

import Link from "next/link";
import { usd } from "@/lib/api";
import { Head, call, useAct, useData, useToast } from "@/components/admin/kit";

type Overview = Record<string, number>;
type U = { id: number; name: string; email: string; status: string; created_at: string };
type M = { id: string; name: string; alerts: { severity: string; text: string }[] };

export default function Dashboard() {
  const o = useData<Overview>("/admin/overview");
  const pending = useData<U[]>("/admin/users?status=pending");
  const mon = useData<M[]>("/admin/monitoring");
  const { show, node } = useToast();
  const act = useAct(() => { o.reload(); pending.reload(); }, show);
  const v = o.data;
  const tiles: [string, string | number, string, string][] = v ? [
    ["Users awaiting approval", v.users_pending, `${v.users_total} accounts`, "/admin/users"],
    ["Twins awaiting mint", v.twins_awaiting_mint, `${v.yachts_active} active yachts`, "/admin/yachts"],
    ["KYC pending", v.kyc_pending, "investor reviews", "/admin/investors"],
    ["Bank details to verify", v.bank_unverified, "payout accounts", "/admin/banking"],
    ["Held in escrow", usd(v.escrow_held_usd, true), "awaiting arrival proof", "/admin/operations"],
    ["Events not yet anchored", v.events_unanchored, `${v.anchors} anchors so far`, "/admin/hashes"],
  ] : [];
  const alerts = (mon.data ?? []).flatMap((m) => m.alerts.map((a) => ({ ...a, yacht: m.name, id: m.id })));
  return (
    <>
      <Head eyebrow="Admin console" title="Dashboard" />
      {o.err && <p className="err">{o.err}</p>}
      <div className="grid g3">
        {tiles.map(([l, n, d, href]) => (
          <Link key={l} href={href} className="panel kpi tile"><div className="l">{l}</div><div className="v">{n}</div><div className="d">{d}</div></Link>
        ))}
      </div>
      <div className="grid g2">
        <div className="panel">
          <header><h3>New accounts</h3><Link href="/admin/users" className="small">All users →</Link></header>
          {pending.data?.length ? pending.data.map((u) => (
            <div className="kv" key={u.id}>
              <span><b style={{ color: "var(--ink)" }}>{u.name}</b><br /><span className="small">{u.email}</span></span>
              <span className="row" style={{ gap: 6 }}>
                <button className="sm primary" onClick={() => act(() => call(`/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }), `${u.name} approved`)}>Approve</button>
                <button className="sm" onClick={() => act(() => call(`/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) }), `${u.name} suspended`)}>Decline</button>
              </span>
            </div>
          )) : <p className="muted small">No accounts waiting.</p>}
        </div>
        <div className="panel">
          <header><h3>Attention needed</h3><Link href="/admin/monitoring" className="small">Monitoring →</Link></header>
          {alerts.length ? alerts.slice(0, 8).map((a, i) => (
            <div className="alert" key={i}><span className={`sev ${a.severity}`} /><div><b>{a.yacht}</b> <span className="small muted">{a.id}</span><br /><span className="small">{a.text}</span></div></div>
          )) : <p className="muted small">All yachts look healthy.</p>}
        </div>
      </div>
      {node}
    </>
  );
}
