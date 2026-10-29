"""Optional on-chain anchoring. When CHAIN_RPC is not set, roots are stored in Postgres only."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import get_settings

log = logging.getLogger(__name__)

PROOF_REGISTRY_ABI = [
    {
        "name": "anchor",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "root", "type": "bytes32"},
            {"name": "leafCount", "type": "uint32"},
            {"name": "fromTs", "type": "uint64"},
            {"name": "toTs", "type": "uint64"},
        ],
        "outputs": [{"name": "index", "type": "uint256"}],
    },
    {
        "name": "Anchored",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "index", "type": "uint256", "indexed": True},
            {"name": "root", "type": "bytes32", "indexed": True},
            {"name": "leafCount", "type": "uint32", "indexed": False},
            {"name": "fromTs", "type": "uint64", "indexed": False},
            {"name": "toTs", "type": "uint64", "indexed": False},
        ],
    },
    {
        "name": "verify",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "leaf", "type": "bytes32"},
            {"name": "proof", "type": "bytes32[]"},
            {"name": "leafIndex", "type": "uint256"},
            {"name": "anchorIndex", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


YACHT_TWIN_ABI = [
    {
        "name": "mint",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "yachtId", "type": "string"},
            {"name": "registryRef", "type": "bytes32"},
            {"name": "docsRoot", "type": "bytes32"},
        ],
        "outputs": [{"name": "tokenId", "type": "uint256"}],
    },
    {
        "name": "idByYachtId",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "TwinMinted",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "yachtId", "type": "string", "indexed": False},
            {"name": "registryRef", "type": "bytes32", "indexed": False},
            {"name": "docsRoot", "type": "bytes32", "indexed": False},
        ],
    },
]


@dataclass
class AnchorReceipt:
    tx_hash: str
    index: int


class ChainClient:
    def __init__(self):
        s = get_settings()
        self.enabled = bool(s.chain_rpc and s.anchor_private_key and s.proof_registry_address)
        self.twin_enabled = bool(s.chain_rpc and s.anchor_private_key and s.yacht_twin_address)
        if not (self.enabled or self.twin_enabled):
            return
        from web3 import Web3

        self.w3 = Web3(Web3.HTTPProvider(s.chain_rpc))
        self.account = self.w3.eth.account.from_key(s.anchor_private_key)
        if self.enabled:
            self.registry = self.w3.eth.contract(
                address=Web3.to_checksum_address(s.proof_registry_address), abi=PROOF_REGISTRY_ABI
            )
        if self.twin_enabled:
            self.twin = self.w3.eth.contract(address=Web3.to_checksum_address(s.yacht_twin_address), abi=YACHT_TWIN_ABI)

    def _send(self, fn):
        tx = fn.build_transaction(
            {"from": self.account.address, "nonce": self.w3.eth.get_transaction_count(self.account.address)}
        )
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return h, self.w3.eth.wait_for_transaction_receipt(h, timeout=60)

    def mint_twin(self, yacht_id: str, registry_ref: bytes, docs_root: bytes, owner: str | None = None) -> AnchorReceipt | None:
        """Mints the ERC-721 twin to the platform custody address (owner) and returns the token id."""
        if not self.twin_enabled:
            return None
        h, rcpt = self._send(self.twin.functions.mint(owner or self.account.address, yacht_id, registry_ref, docs_root))
        from web3.logs import DISCARD

        ev = self.twin.events.TwinMinted().process_receipt(rcpt, errors=DISCARD)[0]
        return AnchorReceipt(tx_hash=h.hex(), index=int(ev["args"]["tokenId"]))

    def twin_id_of(self, yacht_id: str) -> int:
        """Token id already minted for this yacht id, or 0."""
        if not self.twin_enabled:
            return 0
        return int(self.twin.functions.idByYachtId(self.w3.keccak(text=yacht_id)).call())

    def anchor(self, root: bytes, leaf_count: int, from_ts: int, to_ts: int) -> AnchorReceipt | None:
        if not self.enabled:
            return None
        fn = self.registry.functions.anchor(root, leaf_count, from_ts, to_ts)
        tx = fn.build_transaction(
            {
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
            }
        )
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h, timeout=60)
        ev = self.registry.events.Anchored().process_receipt(rcpt)[0]
        return AnchorReceipt(tx_hash=h.hex(), index=int(ev["args"]["index"]))

    def verify(self, leaf: bytes, proof: list[bytes], leaf_index: int, anchor_index: int) -> bool | None:
        if not self.enabled:
            return None
        return bool(self.registry.functions.verify(leaf, proof, leaf_index, anchor_index).call())
