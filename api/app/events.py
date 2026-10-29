"""Recording hashable events and anchoring them in Merkle batches."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import proof
from .chain import ChainClient


def record_event(
    db: Session,
    yacht_id: str,
    event_type: str,
    observed_at: datetime | None = None,
    marina_id: str = "",
    berth_code: str = "",
    lat: float | None = None,
    lon: float | None = None,
    document_hash: str = "",
    payload: dict | None = None,
    leaf: bytes | None = None,
) -> int:
    """Insert an event and return its id. `leaf` overrides the canonical hash (arrival events)."""
    observed_at = observed_at or datetime.now(timezone.utc)
    if leaf is None:
        leaf = proof.event_hash(
            yacht_id=yacht_id,
            event_type=event_type,
            timestamp=observed_at,
            marina_id=marina_id,
            berth_id=berth_code,
            lat=lat,
            lon=lon,
            document_hash=document_hash,
        )
    return db.execute(
        text(
            """INSERT INTO events (yacht_id, event_type, marina_id, berth_code, observed_at, lat, lon,
                                   document_hash, payload, leaf)
               VALUES (:y, :t, :m, :b, :ts, :lat, :lon, :d, CAST(:p AS JSONB), :leaf) RETURNING id"""
        ),
        dict(
            y=yacht_id, t=event_type, m=marina_id, b=berth_code, ts=observed_at, lat=lat, lon=lon,
            d=document_hash, p=json.dumps(payload or {}), leaf=leaf.hex(),
        ),
    ).scalar_one()


def anchor_pending(db: Session, chain: ChainClient | None = None, max_leaves: int = 50_000) -> dict | None:
    rows = db.execute(
        text(
            """SELECT id, leaf, observed_at FROM events WHERE anchor_id IS NULL
               ORDER BY id LIMIT :n FOR UPDATE SKIP LOCKED"""
        ),
        {"n": max_leaves},
    ).all()
    if not rows:
        return None
    leaves = [bytes.fromhex(r.leaf) for r in rows]
    root = proof.merkle_root(leaves)
    from_ts = min(r.observed_at for r in rows)
    to_ts = max(r.observed_at for r in rows)
    anchor_id = db.execute(
        text(
            """INSERT INTO anchors (root, leaf_count, from_ts, to_ts) VALUES (:r, :n, :f, :t) RETURNING id"""
        ),
        dict(r=root.hex(), n=len(leaves), f=from_ts, t=to_ts),
    ).scalar_one()
    db.execute(
        text(
            """UPDATE events e SET anchor_id = :a, leaf_index = v.idx
               FROM (SELECT unnest(CAST(:ids AS BIGINT[])) AS id,
                            generate_series(0, :n - 1) AS idx) v
               WHERE e.id = v.id"""
        ),
        dict(a=anchor_id, ids=[r.id for r in rows], n=len(rows)),
    )
    receipt = None
    if chain is not None and chain.enabled:
        receipt = chain.anchor(root, len(leaves), int(from_ts.timestamp()), int(to_ts.timestamp()))
        db.execute(
            text("UPDATE anchors SET chain_tx = :tx, chain_index = :i WHERE id = :a"),
            dict(tx=receipt.tx_hash, i=receipt.index, a=anchor_id),
        )
    db.execute(
        text("INSERT INTO chain_txs (kind, ref, tx_hash, contract, detail) VALUES ('anchor', :r, :tx, :c, CAST(:d AS JSONB))"),
        dict(r=str(anchor_id), tx=receipt.tx_hash if receipt else None,
             c=getattr(getattr(chain, "registry", None), "address", None),
             d=json.dumps({"root": root.hex(), "leaves": len(leaves)})),
    )
    db.commit()
    return {
        "anchor_id": anchor_id,
        "root": root.hex(),
        "leaf_count": len(leaves),
        "chain_tx": receipt.tx_hash if receipt else None,
        "chain_index": receipt.index if receipt else None,
    }


def proof_for_event(db: Session, event_id: int) -> dict | None:
    ev = db.execute(
        text("SELECT id, yacht_id, event_type, leaf, anchor_id, leaf_index FROM events WHERE id = :i"),
        {"i": event_id},
    ).first()
    if ev is None:
        return None
    if ev.anchor_id is None:
        return {"event_id": ev.id, "leaf": ev.leaf, "anchored": False}
    a = db.execute(text("SELECT * FROM anchors WHERE id = :a"), {"a": ev.anchor_id}).first()
    leaves = [
        bytes.fromhex(r.leaf)
        for r in db.execute(
            text("SELECT leaf FROM events WHERE anchor_id = :a ORDER BY leaf_index"), {"a": ev.anchor_id}
        )
    ]
    p = proof.merkle_proof(leaves, ev.leaf_index)
    return {
        "event_id": ev.id,
        "yacht_id": ev.yacht_id,
        "event_type": ev.event_type,
        "anchored": True,
        "leaf": ev.leaf,
        "leaf_index": ev.leaf_index,
        "proof": [x.hex() for x in p],
        "root": a.root,
        "anchor_id": a.id,
        "chain_tx": a.chain_tx,
        "chain_index": a.chain_index,
        "verified_offchain": proof.compute_root(bytes.fromhex(ev.leaf), p, ev.leaf_index).hex() == a.root,
    }
