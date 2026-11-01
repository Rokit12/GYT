"""Optional AI (Claude) helpers for the autopilot. Off unless ANTHROPIC_API_KEY is set.

Safety rules, by design:
  * The AI only reads and summarises. It never approves an account, places or cancels a booking,
    releases escrow or changes a berth. Those stay with the deterministic rules and with admins.
  * Its output is structured (a forced tool call with a fixed schema) and checked before use.
  * If the AI is off, slow or wrong-shaped, everything still works: callers get
    {"available": False} and the rules carry on alone.
"""
from __future__ import annotations

import base64
import logging

import httpx

from .config import get_settings

log = logging.getLogger("gyt.ai")
API = "https://api.anthropic.com/v1/messages"


def enabled() -> bool:
    return bool(get_settings().anthropic_api_key)


def _call(system: str, content: list, tool: dict, max_tokens: int = 800) -> dict | None:
    s = get_settings()
    r = httpx.post(
        API,
        headers={"x-api-key": s.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": s.ai_model, "max_tokens": max_tokens, "system": system,
              "tools": [tool], "tool_choice": {"type": "tool", "name": tool["name"]},
              "messages": [{"role": "user", "content": content}]},
        timeout=45,
    )
    r.raise_for_status()
    for block in r.json().get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == tool["name"]:
            return block.get("input")
    return None


REGISTRY_TOOL = {
    "name": "report_certificate",
    "description": "Report what the ship registry certificate says and whether it matches the owner's claim.",
    "input_schema": {
        "type": "object",
        "properties": {
            "is_registry_certificate": {"type": "boolean", "description": "Is this a certificate of registry (or equivalent) for a vessel?"},
            "vessel_name": {"type": "string"}, "flag": {"type": "string"},
            "length_m": {"type": "number", "description": "Registered length in metres, if shown"},
            "registry_number": {"type": "string"}, "mmsi": {"type": "string"}, "imo": {"type": "string"},
            "owner_name": {"type": "string"},
            "mismatches": {"type": "array", "items": {"type": "string"},
                           "description": "Each way the certificate disagrees with the claim, in plain words"},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        },
        "required": ["is_registry_certificate", "mismatches", "confidence"],
    },
}


def read_registry_document(data: bytes, mime: str, claim: dict) -> dict:
    """Read an uploaded registry certificate and compare it with what the owner typed."""
    if not enabled():
        return {"available": False}
    b64 = base64.standard_b64encode(data).decode()
    src = {"type": "base64", "media_type": mime, "data": b64}
    block = {"type": "document", "source": src} if mime == "application/pdf" else {"type": "image", "source": src}
    try:
        out = _call(
            "You check yacht registration documents for a marine registry service. Read the attached document "
            "and report its contents with the report_certificate tool. Compare it to the owner's claim. Length may "
            "differ by up to 5% between 'length overall' and 'registered length'. Names may differ in case or "
            "punctuation. Never guess a value you cannot read; leave it out.",
            [block, {"type": "text", "text": f"Owner's claim: {claim}"}],
            REGISTRY_TOOL,
        )
    except Exception as e:  # network, auth, rate limit: the rules carry on without AI
        log.warning("AI document read failed: %s", e)
        return {"available": False, "error": str(e)[:200]}
    if not isinstance(out, dict) or "mismatches" not in out:
        return {"available": False, "error": "unexpected AI output"}
    mism = [str(m)[:200] for m in (out.get("mismatches") or [])][:10]
    if not out.get("is_registry_certificate"):
        mism.insert(0, "Document does not look like a certificate of registry")
    if out.get("confidence") == "low":
        mism.append("AI could not read the document clearly")
    return {"available": True, "matches": not mism, "mismatches": mism,
            "read": {k: out.get(k) for k in ("vessel_name", "flag", "length_m", "registry_number", "mmsi", "imo", "owner_name")},
            "confidence": out.get("confidence")}


BRIEF_TOOL = {
    "name": "brief",
    "description": "A short plain-English brief for the operations team.",
    "input_schema": {"type": "object", "properties": {
        "headline": {"type": "string", "description": "One sentence: the most important thing right now"},
        "actions": {"type": "array", "items": {"type": "string"}, "description": "Up to 5 concrete next steps for a human"},
    }, "required": ["headline", "actions"]},
}


def write_brief(findings: list[dict]) -> dict:
    """Turn the autopilot's findings into a short brief for admins. Advice only."""
    if not enabled() or not findings:
        return {"available": False}
    try:
        out = _call("You write terse operations briefs for a yacht marina platform. Use only the facts given.",
                    [{"type": "text", "text": f"Findings from automated checks: {findings[:40]}"}], BRIEF_TOOL, 500)
    except Exception as e:
        log.warning("AI brief failed: %s", e)
        return {"available": False}
    if not isinstance(out, dict) or "headline" not in out:
        return {"available": False}
    return {"available": True, "headline": str(out["headline"])[:300], "actions": [str(a)[:200] for a in out.get("actions", [])][:5]}
