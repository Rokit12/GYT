"use client";

import { useState } from "react";
import { call } from "@/lib/api";
import { computeRoot } from "@/lib/merkle";

type Proof = {
  event_id: number; yacht_id: string; event_type: string; anchored: boolean; leaf: string; leaf_index?: number;
  proof?: string[]; root?: string; anchor_id?: number; chain_tx?: string | null;
};

// Paste any GYT event hash; the browser recomputes the Merkle path and compares it to the anchored root.
export default function HashCheck({ initial = "", compact = false }: { initial?: string; compact?: boolean }) {
  const [hash, setHash] = useState(initial);
  const [res, setRes] = useState<{ p?: Proof; ok?: boolean; err?: string; busy?: boolean }>({});

  async function check(e?: React.FormEvent) {
    e?.preventDefault();
    setRes({ busy: true });
    try {
      const p = await call<Proof>(`/verify/${hash.trim()}`);
      if (!p.anchored) return setRes({ p });
      const { root } = await computeRoot(p.leaf, p.proof!, p.leaf_index!);
      setRes({ p, ok: root === p.root });
    } catch (err) {
      setRes({ err: (err as Error).message });
    }
  }

  return (
    <div className={`hashcheck ${compact ? "compact" : ""}`}>
      <form onSubmit={check} className="row">
        <label className="sr" htmlFor="hc">Event hash</label>
        <input id="hc" className="mono" placeholder="Paste a 64-character event hash" value={hash} onChange={(e) => setHash(e.target.value)} />
        <button className="primary" disabled={!hash.trim() || res.busy}>{res.busy ? "Checking…" : "Verify"}</button>
      </form>
      {res.err && <p className="err" role="alert">{res.err}</p>}
      {res.p && !res.p.anchored && <p className="small">Record found ({res.p.event_type}). It will be anchored on-chain within the next few minutes.</p>}
      {res.p?.anchored && (
        <div className={`verdict ${res.ok ? "ok" : "crit"}`} role="status">
          <b>{res.ok ? "Verified: this record has not been changed" : "Mismatch: this record does not match its anchor"}</b>
          <span className="small">
            {res.p.event_type} for {res.p.yacht_id} · anchor #{res.p.anchor_id} · {res.p.proof!.length} proof steps recomputed in your browser
          </span>
          {res.p.chain_tx && <span className="mono small">On-chain tx {res.p.chain_tx}</span>}
        </div>
      )}
    </div>
  );
}
