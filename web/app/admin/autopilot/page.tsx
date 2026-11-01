"use client";

import { useEffect, useState } from "react";
import { Head, call, useAct, useData, useToast } from "@/components/admin/kit";

type Log = { id: number; at: string; job: string; subject: string; outcome: string; summary: string; used_ai: boolean; resolved: boolean; detail: Record<string, unknown> };
type Overview = {
  ai_enabled: boolean; ai_model: string | null; interval_seconds: number; auto_approve: boolean;
  last_run: { at: string; result: Record<string, unknown> } | null;
  counts: { open_flags: number; ready_to_approve: number; needs_review: number; done_24h: number }; log: Log[];
};
type Reg = { id: number; name: string; email: string; status: string; vessel_name: string; flag: string; mmsi: string | null; imo: string | null; loa_m: number; registry_number: string; doc_sha256: string | null;
  screening: { checks?: { key: string; ok: boolean; msg: string }[]; recommendation?: string; ai?: { available: boolean; read?: Record<string, unknown>; mismatches?: string[] } } };

const JOB: Record<string, string> = { holds: "Berth holds", berth_fit: "Berth fit", arrivals: "Arrivals", registrations: "Sign-ups", brief: "AI brief" };
const TONE: Record<string, string> = { flagged: "crit", needs_review: "warn", recommend_approve: "ok", done: "ok", info: "info" };

export default function Autopilot() {
  const { data, err, reload } = useData<Overview>("/admin/autopilot?limit=120");
  const regs = useData<Reg[]>("/admin/registrations");
  const { show, node } = useToast();
  const act = useAct(() => { reload(); regs.reload(); }, show);
  const [job, setJob] = useState("all");
  useEffect(() => { const t = setInterval(reload, 10_000); return () => clearInterval(t); }, [reload]);
  const log = (data?.log ?? []).filter((l) => job === "all" || l.job === job);

  return (
    <>
      <Head eyebrow="Automation" title="Autopilot">
        <button className="primary" onClick={() => act(() => call("/admin/autopilot/run", { method: "POST" }), "Autopilot ran every check")}>Run now</button>
        <button onClick={() => act(() => call("/admin/autopilot/approve-recommended", { method: "POST" }), "Approved every recommended owner")} disabled={!data?.counts.ready_to_approve}>
          Approve recommended ({data?.counts.ready_to_approve ?? 0})</button>
      </Head>
      {err && <p className="err">{err}</p>}
      <div className="panel ap-status">
        <span className={`pill ${data?.ai_enabled ? "ok" : ""}`}>{data?.ai_enabled ? `AI on · ${data.ai_model}` : "AI off: rules only"}</span>
        <span className="small muted">Runs every {data?.interval_seconds ? `${Math.round(data.interval_seconds / 60)} min` : "— (manual only)"} · last run {data?.last_run ? new Date(data.last_run.at).toLocaleTimeString() : "not yet"}
          {" "}· accounts approved {data?.auto_approve ? "automatically when every check passes" : "by an admin"}</span>
        <p className="small muted" style={{ margin: 0 }}>The rules decide: a yacht never gets a berth it doesn&apos;t fit, and no one is approved unless every check passes. AI only reads documents and summarises; it can add a reason to review, never approve, move money or change bookings.</p>
      </div>
      <div className="grid g4">
        <div className="panel kpi"><div className="l">Open flags</div><div className="v" style={{ color: data?.counts.open_flags ? "var(--crit)" : undefined }}>{data?.counts.open_flags ?? "—"}</div></div>
        <div className="panel kpi"><div className="l">Owners ready to approve</div><div className="v">{data?.counts.ready_to_approve ?? "—"}</div></div>
        <div className="panel kpi"><div className="l">Need review</div><div className="v">{data?.counts.needs_review ?? "—"}</div></div>
        <div className="panel kpi"><div className="l">Tasks done, 24 h</div><div className="v">{data?.counts.done_24h ?? "—"}</div></div>
      </div>

      <div className="panel">
        <header><h3>Owner sign-ups waiting</h3><span className="small muted">Screened automatically</span></header>
        {regs.data?.length ? (
          <div className="tbl"><table><thead><tr><th>Owner</th><th>Yacht</th><th>Checks</th><th>AI reading</th><th /></tr></thead><tbody>
            {regs.data.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b><br /><span className="small muted">{r.email}</span></td>
                <td>{r.vessel_name} · {r.flag} · {r.loa_m} m<br /><span className="mono small muted">{r.mmsi ? `MMSI ${r.mmsi}` : ""} {r.imo ? `IMO ${r.imo}` : ""} · {r.registry_number}</span></td>
                <td className="small">{(r.screening.checks ?? []).map((c) => <div key={c.key} className={c.ok ? "ok-t" : "crit-t"}>{c.ok ? "✓" : "✗"} {c.msg}</div>)}{!r.screening.checks && <span className="muted">Not screened yet</span>}</td>
                <td className="small">{r.screening.ai?.available ? (r.screening.ai.mismatches?.length ? r.screening.ai.mismatches.join("; ") : "Matches the claim") : <span className="muted">AI off</span>}</td>
                <td className="row">
                  {r.doc_sha256 && <a className="btn sm" href={`/api/gyt/admin/registrations/${r.id}/document`} target="_blank" rel="noopener">Certificate</a>}
                  <button className="sm" onClick={() => act(() => call(`/admin/registrations/${r.id}/screen`, { method: "POST" }), "Screened again")}>Re-check</button>
                  <button className="sm primary" onClick={() => act(() => call(`/admin/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }), `Approved ${r.name}`)}>Approve</button>
                </td>
              </tr>
            ))}</tbody></table></div>
        ) : <p className="small muted">No owners waiting.</p>}
      </div>

      <div className="panel">
        <header><h3>What the autopilot did</h3>
          <div className="seg" role="group" aria-label="Filter">{["all", "holds", "berth_fit", "arrivals", "registrations", "brief"].map((j) => <button key={j} aria-pressed={job === j} onClick={() => setJob(j)}>{j === "all" ? "All" : JOB[j]}</button>)}</div></header>
        <ul className="aplist">
          {log.map((l) => (
            <li key={l.id} className={l.resolved ? "res" : ""}>
              <span className={`pill ${TONE[l.outcome] ?? ""}`}>{l.outcome.replace("_", " ")}</span>
              <span className="small muted">{JOB[l.job] ?? l.job}{l.used_ai ? " · AI" : ""}</span>
              <span>{l.summary}</span>
              <span className="small muted">{new Date(l.at).toLocaleString()}</span>
              {!l.resolved && (l.outcome === "flagged" || l.outcome === "needs_review") && <button className="sm" onClick={() => act(() => call(`/admin/autopilot/${l.id}/resolve`, { method: "POST" }), "Marked as handled")}>Handled</button>}
            </li>
          ))}
          {!log.length && <li className="small muted">Nothing yet. Press Run now.</li>}
        </ul>
      </div>
      {node}
    </>
  );
}
