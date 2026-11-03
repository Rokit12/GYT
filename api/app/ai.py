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


PLAN_TOOL = {
    "name": "report_berth_plan",
    "description": "Report every berth drawn on a marina berth plan, with positions as fractions of the image size.",
    "input_schema": {"type": "object", "properties": {
        "is_berth_plan": {"type": "boolean", "description": "Is this a plan, drawing or aerial view of marina berths?"},
        "width_m": {"type": "number", "description": "The real width the whole image covers, in metres, if a scale bar or printed sizes let you work it out"},
        "berths": {"type": "array", "maxItems": 400, "items": {"type": "object", "properties": {
            "code": {"type": "string", "description": "The berth's code as printed on the plan, if any"},
            "end_x": {"type": "number", "description": "x of the centre of the berth's pontoon (quay) end, 0 = left edge, 1 = right edge"},
            "end_y": {"type": "number", "description": "y of the centre of the pontoon end, 0 = top edge, 1 = bottom edge"},
            "tip_x": {"type": "number", "description": "x of the centre of the berth's open (seaward) end"},
            "tip_y": {"type": "number", "description": "y of the centre of the open end"},
            "width_frac": {"type": "number", "description": "The berth's width as a fraction of the image width"},
            "length_m": {"type": "number", "description": "Maximum length printed on the plan for this berth, if any"},
            "beam_m": {"type": "number", "description": "Maximum beam printed for this berth, if any"},
            "depth_m": {"type": "number", "description": "Depth printed for this berth, if any"},
        }, "required": ["end_x", "end_y", "tip_x", "tip_y", "width_frac"]}},
    }, "required": ["is_berth_plan", "berths"]},
}


def _frac(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f <= 1 else None


def read_berth_plan(data: bytes, mime: str) -> dict:
    """Read a berth plan image. The admin reviews the result in the importer before anything is saved."""
    if not enabled():
        return {"available": False}
    src = {"type": "base64", "media_type": mime, "data": base64.standard_b64encode(data).decode()}
    try:
        out = _call(
            "You read marina berth plans for a berth booking service. Find every individual berth (a slip or "
            "mooring space for one yacht, usually between finger piers or drawn as a rectangle) and report it with "
            "the report_berth_plan tool. Give positions as fractions of the image width and height. The pontoon end "
            "is the end at the pontoon or quay; the tip is the open, seaward end. Copy berth codes and sizes exactly "
            "as printed; never invent a code or size you cannot read.",
            [{"type": "image", "source": src}, {"type": "text", "text": "Report every berth on this plan."}],
            PLAN_TOOL, max_tokens=8000,
        )
    except Exception as e:
        log.warning("AI plan read failed: %s", e)
        return {"available": False, "error": str(e)[:200]}
    if not isinstance(out, dict) or not isinstance(out.get("berths"), list):
        return {"available": False, "error": "unexpected AI output"}
    if not out.get("is_berth_plan"):
        return {"available": True, "berths": [], "note": "This image does not look like a berth plan"}
    berths = []
    for b in out["berths"][:400]:
        if not isinstance(b, dict):
            continue
        pts = [_frac(b.get(k)) for k in ("end_x", "end_y", "tip_x", "tip_y", "width_frac")]
        if any(p is None for p in pts) or pts[4] <= 0:
            continue
        item = dict(zip(("end_x", "end_y", "tip_x", "tip_y", "width_frac"), pts))
        code = str(b.get("code") or "").strip().upper()[:20]
        if code:
            item["code"] = code
        for k, hi in (("length_m", 200), ("beam_m", 60), ("depth_m", 40)):
            try:
                v = float(b.get(k))
                if 0 < v <= hi:
                    item[k] = v
            except (TypeError, ValueError):
                pass
        berths.append(item)
    w = out.get("width_m")
    width = float(w) if isinstance(w, (int, float)) and 5 < w < 5000 else None
    return {"available": True, "width_m": width, "berths": berths}
