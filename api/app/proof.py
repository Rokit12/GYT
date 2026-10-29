"""Hashing and Merkle proofs.

Tree rules are shared with contracts/src/ProofRegistry.sol and web/lib/merkle.ts:
  leaf   = sha256(event bytes)
  parent = sha256(left || right)      ordered, not sorted
  an odd node at the end of a level is paired with itself
A test in each language checks the same vector, so the three implementations cannot drift.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def canonical_event(
    yacht_id: str,
    event_type: str,
    timestamp: datetime,
    marina_id: str = "",
    berth_id: str = "",
    lat: float | None = None,
    lon: float | None = None,
    document_hash: str = "",
) -> bytes:
    """Canonical byte form of an event: fixed field order, UTC ISO time, 6-decimal coordinates."""
    ts = timestamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    coord = lambda v: "" if v is None else f"{v:.6f}"  # noqa: E731
    parts = [yacht_id, event_type, marina_id, berth_id, ts, coord(lat), coord(lon), document_hash]
    return "|".join(parts).encode("utf-8")


def event_hash(**kwargs) -> bytes:
    return sha256(canonical_event(**kwargs))


def arrival_leaf(booking_ref: bytes, twin_id: int, marina_id: bytes, fusion_digest: bytes) -> bytes:
    """Matches ArrivalEscrow.arrivalLeaf: sha256(ref32 || uint256 twinId || marina32 || digest32)."""
    for name, v in (("booking_ref", booking_ref), ("marina_id", marina_id), ("fusion_digest", fusion_digest)):
        if len(v) != 32:
            raise ValueError(f"{name} must be 32 bytes")
    return sha256(booking_ref + twin_id.to_bytes(32, "big") + marina_id + fusion_digest)


def to_bytes32(text: str) -> bytes:
    """Left-aligned, zero-padded bytes32 for short ids such as booking refs and marina ids."""
    raw = text.encode("utf-8")
    if len(raw) > 32:
        raise ValueError("id longer than 32 bytes")
    return raw.ljust(32, b"\x00")


def build_levels(leaves: list[bytes]) -> list[list[bytes]]:
    if not leaves:
        raise ValueError("cannot build a tree with no leaves")
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            left = cur[i]
            right = cur[i + 1] if i + 1 < len(cur) else cur[i]
            nxt.append(sha256(left + right))
        levels.append(nxt)
    return levels


def merkle_root(leaves: list[bytes]) -> bytes:
    return build_levels(leaves)[-1][0]


def merkle_proof(leaves: list[bytes], index: int) -> list[bytes]:
    if not 0 <= index < len(leaves):
        raise IndexError("leaf index out of range")
    proof = []
    for level in build_levels(leaves)[:-1]:
        sib = index ^ 1
        proof.append(level[sib] if sib < len(level) else level[index])
        index >>= 1
    return proof


def compute_root(leaf: bytes, proof: list[bytes], index: int) -> bytes:
    h = leaf
    for sib in proof:
        h = sha256(sib + h) if index & 1 else sha256(h + sib)
        index >>= 1
    return h


@dataclass
class Batch:
    leaves: list[bytes]

    @property
    def root(self) -> bytes:
        return merkle_root(self.leaves)

    def proof_for(self, index: int) -> list[bytes]:
        return merkle_proof(self.leaves, index)
