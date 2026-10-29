"use client";

import { useState } from "react";
import { Head, useData, when } from "@/components/admin/kit";

type A = { id: number; actor: string; action: string; entity: string; entity_id: string; detail: Record<string, unknown>; at: string };

export default function Audit() {
  const { data, err } = useData<A[]>("/admin/audit?limit=500");
  const [q, setQ] = useState("");
  const list = (data ?? []).filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Head eyebrow="Records" title="Audit log">
        <input aria-label="Filter" placeholder="Filter by admin, entity or id" value={q} onChange={(e) => setQ(e.target.value)} />
      </Head>
      <p className="small muted">Every admin change is recorded here with who made it. Bank account numbers are never written to this log.</p>
      {err && <p className="err">{err}</p>}
      <div className="panel tbl">
        <table>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="small">{when(a.at)}</td>
                <td className="small">{a.actor}</td>
                <td><span className={`pill ${a.action === "delete" ? "crit" : a.action === "mint" || a.action === "approve" ? "ok" : ""}`}>{a.action}</span></td>
                <td className="mono small">{a.entity} · {a.entity_id}</td>
                <td className="small wrapcell"><span className="mono">{JSON.stringify(a.detail).slice(0, 140)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
