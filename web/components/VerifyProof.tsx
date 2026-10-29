"use client";

import { useState } from "react";
import { call } from "@/lib/api";
import { computeRoot, type ProofStep } from "@/lib/merkle";

type ProofResp = {
  anchored: boolean;
  leaf: string;
  leaf_index?: number;
  proof?: string[];
  root?: string;
  anchor_id?: number;
  chain_tx?: string | null;
};

export default function VerifyProof({ eventId, eventType, leaf }: { eventId: number; eventType: string; leaf: string }) {
  const [state, setState] = useState<{ p?: ProofResp; steps?: ProofStep[]; ok?: boolean; err?: string }>({});

  async function verify() {
    try {
      const p = await call<ProofResp>(`/proofs/${eventId}`);
      if (!p.anchored) return setState({ p });
      const { root, steps } = await computeRoot(p.leaf, p.proof!, p.leaf_index!);
      setState({ p, steps, ok: root === p.root });
    } catch (e) {
      setState({ err: (e as Error).message });
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="hashbox"><b>{eventType}</b> leaf {leaf}</div>
      <div className="row">
        <button onClick={verify}>Verify this record</button>
        <span className="small muted">Recomputes the Merkle path in your browser. No trust in GYT needed.</span>
      </div>
      {state.err && <p className="err">{state.err}</p>}
      {state.p && !state.p.anchored && <p className="small muted">Waiting for the next anchor. Try again in a few minutes.</p>}
      {state.steps && (
        <div className="hashbox">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>Anchor #{state.p!.anchor_id}</b>
            <span className={`pill ${state.ok ? "ok" : "crit"}`}>{state.ok ? "Root matches: record untampered" : "Mismatch"}</span>
          </div>
          {state.steps.map((s, i) => (
            <div key={i}>+ {s.side} sibling {s.sibling.slice(0, 10)}… → {s.result.slice(0, 10)}…</div>
          ))}
          <div><b>Root</b> {state.p!.root}</div>
          {state.p!.chain_tx && <div><b>Chain tx</b> {state.p!.chain_tx}</div>}
        </div>
      )}
    </div>
  );
}
