"use client";

import { useState } from "react";
import HashCheck from "@/components/HashCheck";
import { Head, call, short, useAct, useData, useToast, when } from "@/components/admin/kit";

type H = {
  contracts: Record<string, string | null>;
  anchors: { id: number; root: string; leaf_count: number; chain_tx: string | null; chain_index: number | null; created_at: string }[];
  chain_txs: { id: number; kind: string; ref: string; tx_hash: string | null; contract: string | null; created_at: string; detail: Record<string, unknown> }[];
  events: { id: number; yacht_id: string; event_type: string; observed_at: string; leaf: string; anchor_id: number | null }[];
  wallets: { kind: string; id: string; name: string; address: string }[];
  twins: { id: string; name: string; twin_status: string; twin_token_id: number | null; twin_tx: string | null; docs_root: string | null }[];
};

const TABS = ["Contracts", "Anchors", "Transactions", "Event hashes", "Twins", "Wallets"] as const;

function Copy({ v }: { v: string | null }) {
  const [c, setC] = useState(false);
  if (!v) return <span className="muted">—</span>;
  return (
    <button className="hashbtn mono" title={v} onClick={async () => { try { await navigator.clipboard.writeText(v); setC(true); setTimeout(() => setC(false), 1200); } catch { /* selection fallback */ } }}>
      {c ? "Copied" : short(v, 12)}
    </button>
  );
}

export default function Hashes() {
  const { data, err, reload } = useData<H>("/admin/hashes");
  const { show, node } = useToast();
  const act = useAct(reload, show);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Contracts");
  const [q, setQ] = useState("");
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  return (
    <>
      <Head eyebrow="Registry" title="Hashes & addresses">
        <button className="primary" onClick={() => act(() => call("/anchors", { method: "POST" }), "Pending events anchored")}>Anchor pending events now</button>
      </Head>
      {err && <p className="err">{err}</p>}
      <div className="row">
        <div className="seg" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
        <input aria-label="Filter" placeholder="Filter by id, type or hash" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
      </div>
      <div className="panel tbl">
        {tab === "Contracts" && data && (
          <table><thead><tr><th>Contract</th><th>Address</th></tr></thead><tbody>
            {Object.entries(data.contracts).map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono small">{v ?? <span className="muted">not configured</span>}</td></tr>)}
          </tbody></table>
        )}
        {tab === "Anchors" && (
          <table><thead><tr><th>#</th><th className="r">Events</th><th>Merkle root</th><th>Chain tx</th><th className="r">Chain index</th><th>When</th></tr></thead><tbody>
            {data?.anchors.filter((a) => match(`${a.id} ${a.root} ${a.chain_tx}`)).map((a) => (
              <tr key={a.id}><td className="mono">{a.id}</td><td className="r">{a.leaf_count}</td><td><Copy v={a.root} /></td><td><Copy v={a.chain_tx} /></td><td className="r mono">{a.chain_index ?? "—"}</td><td className="small">{when(a.created_at)}</td></tr>
            ))}
          </tbody></table>
        )}
        {tab === "Transactions" && (
          <table><thead><tr><th>Kind</th><th>Ref</th><th>Tx hash</th><th>Contract</th><th>Detail</th><th>When</th></tr></thead><tbody>
            {data?.chain_txs.filter((t) => match(`${t.kind} ${t.ref} ${t.tx_hash}`)).map((t) => (
              <tr key={t.id}><td><span className="pill">{t.kind.replace("_", " ")}</span></td><td className="mono small">{t.ref}</td><td>{t.tx_hash ? <Copy v={t.tx_hash} /> : <span className="pill warn">off-chain</span>}</td><td><Copy v={t.contract} /></td><td className="small wrapcell"><span className="mono">{JSON.stringify(t.detail).slice(0, 90)}</span></td><td className="small">{when(t.created_at)}</td></tr>
            ))}
          </tbody></table>
        )}
        {tab === "Event hashes" && (
          <table><thead><tr><th>Event</th><th>Yacht</th><th>Leaf hash</th><th>Anchor</th><th>When</th></tr></thead><tbody>
            {data?.events.filter((e) => match(`${e.event_type} ${e.yacht_id} ${e.leaf}`)).map((e) => (
              <tr key={e.id}><td className="small">{e.event_type}</td><td className="mono small">{e.yacht_id}</td><td><Copy v={e.leaf} /></td><td>{e.anchor_id ? <span className="pill ok">#{e.anchor_id}</span> : <span className="pill warn">pending</span>}</td><td className="small">{when(e.observed_at)}</td></tr>
            ))}
          </tbody></table>
        )}
        {tab === "Twins" && (
          <table><thead><tr><th>Yacht</th><th>Status</th><th>Token</th><th>Mint tx</th><th>Documents root</th></tr></thead><tbody>
            {data?.twins.filter((t) => match(`${t.id} ${t.name} ${t.twin_tx}`)).map((t) => (
              <tr key={t.id}><td><b>{t.name}</b><br /><span className="mono small muted">{t.id}</span></td><td><span className={`pill ${t.twin_status === "minted" ? "ok" : "warn"}`}>{t.twin_status}</span></td><td className="mono">{t.twin_token_id ? `#${t.twin_token_id}` : "—"}</td><td><Copy v={t.twin_tx} /></td><td><Copy v={t.docs_root} /></td></tr>
            ))}
          </tbody></table>
        )}
        {tab === "Wallets" && (
          <table><thead><tr><th>Kind</th><th>Id</th><th>Name</th><th>Address</th></tr></thead><tbody>
            {data?.wallets.length ? data.wallets.filter((w) => match(`${w.id} ${w.name} ${w.address}`)).map((w) => (
              <tr key={`${w.kind}${w.id}`}><td><span className="pill">{w.kind}</span></td><td className="mono small">{w.id}</td><td>{w.name}</td><td><Copy v={w.address} /></td></tr>
            )) : <tr><td colSpan={4} className="muted">No wallet addresses recorded. Add them on users or investors.</td></tr>}
          </tbody></table>
        )}
      </div>
      <div className="panel"><header><h3>Verify any hash</h3></header><HashCheck /></div>
      {node}
    </>
  );
}
