"""Tracker message signing (ed25519).

The onboard tracker holds a private key generated on the device. GYT stores only the public
key. Each GPS fix is signed over a canonical message so a fix cannot be forged or replayed for
another yacht.
"""
from __future__ import annotations

from datetime import datetime, timezone

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey


def gps_message(tracker_id: str, yacht_id: str, lat: float, lon: float, observed_at: datetime) -> bytes:
    ts = observed_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"GYT-GPS-v1|{tracker_id}|{yacht_id}|{lat:.6f}|{lon:.6f}|{ts}".encode()


def verify(public_key_hex: str, message: bytes, signature_hex: str) -> bool:
    try:
        VerifyKey(bytes.fromhex(public_key_hex)).verify(message, bytes.fromhex(signature_hex))
        return True
    except (BadSignatureError, ValueError):
        return False


def new_keypair() -> tuple[str, str]:
    """For simulators and tests only. Real trackers generate keys in secure hardware."""
    sk = SigningKey.generate()
    return sk.encode().hex(), sk.verify_key.encode().hex()


def sign(private_key_hex: str, message: bytes) -> str:
    return SigningKey(bytes.fromhex(private_key_hex)).sign(message).signature.hex()
