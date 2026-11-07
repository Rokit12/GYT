"""Autopilot: the routine checks GYT runs by itself, so admins only look at what needs a person.

Every AUTOPILOT_INTERVAL_SECONDS (and whenever an admin presses Run) it:
  1. holds          releases berth holds that ran out, so those berths are offered again
  2. berth_fit      flags any booking whose yacht no longer fits its berth (length, beam, draft)
  3. arrivals       for bookings due today, runs the three-signal arrival check; flags a satellite
                    hull length that does not match the yacht, or a yacht too big for its berth
  4. registrations  screens new owner sign-ups (MMSI/IMO validity, duplicates, document, and the
                    AI reading of the certificate when AI is on) and recommends approve or review
  5. brief          with AI on, writes a short plain-English brief of what is still open

What it will not do on its own: release escrowed money, cancel bookings, or (unless
AUTOPILOT_AUTO_APPROVE is on, and then only when every rule-based check passes) approve accounts.
Everything it does is written to autopilot_log with the reason, and shown in the admin console.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import ai
from .auth import require_right
from .berths import expire_holds, fit
from .config import get_settings
from .db import get_db
from .registration import screen_claim

log = logging.getLogger("gyt.autopilot")
router = APIRouter()
_last_run: dict = {}


def _log(db: Session, job: str, subject: str, outcome: str, summary: str, detail: dict | None = None,
         used_ai: bool = False, dedupe: bool = True) -> bool:
    """Write one log line. With dedupe, an identical open finding is not repeated every run."""
    if dedupe and db.execute(
        text("SELECT 1 FROM autopilot_log WHERE job=:j AND subject=:s AND summary=:m AND NOT resolved LIMIT 1"),
        {"j": job, "s": subject, "m": summary},
    ).first():
        return False
    db.execute(
        text("""INSERT INTO autopilot_log (job, subject, outcome, summary, detail, used_ai)
                VALUES (:j,:s,:o,:m,CAST(:d AS JSONB),:a)"""),
        {"j": job, "s": subject, "o": outcome, "m": summary, "d": json.dumps(detail or {}, default=str), "a": used_ai},
    )
    return True


def run(db: Session) -> dict:
    started = datetime.now(timezone.utc)
    out = {"holds_released": 0, "flags": 0, "arrivals_proven": 0, "registrations_screened": 0, "approved": 0, "brief": None}

    # 1. holds
    n = expire_holds(db)
    out["holds_released"] = n
    if n:
        _log(db, "holds", "", "done", f"Released {n} berth hold{'s' if n != 1 else ''} that ran out; the berths are open again",
             dedupe=False)

    # 2. berth fit for every live booking
    rows = db.execute(text(
        """SELECT k.ref, k.marina_id, k.status, b.code, b.max_loa_m, b.max_beam_m, b.max_draft_m,
                  y.id AS yacht_id, y.name, COALESCE(k.loa_m, y.loa_m) AS loa_m, COALESCE(k.beam_m, y.beam_m) AS beam_m,
                  COALESCE(k.draft_m, y.draft_m) AS draft_m
           FROM bookings k JOIN berths b ON b.id = k.berth_id JOIN yachts y ON y.id = k.yacht_id
           WHERE k.kind='berth' AND k.status IN ('escrowed','arrived') AND k.depart >= CURRENT_DATE""")).mappings().all()
    for r in rows:
        f = fit(r, r)
        if not f["ok"]:
            if _log(db, "berth_fit", r["ref"], "flagged",
                    f"{r['name']} does not fit berth {r['code']}: " + "; ".join(f["reasons"]),
                    {"marina_id": r["marina_id"], "berth": r["code"], "yacht_id": r["yacht_id"], "reasons": f["reasons"]}):
                out["flags"] += 1

    # 3. arrivals due today: three-signal check, plus satellite hull size against the berth
    from .routes import prove_arrival

    due = db.execute(text(
        """SELECT k.ref, k.marina_id, b.code, b.max_loa_m, y.id AS yacht_id, y.name, y.loa_m
           FROM bookings k JOIN berths b ON b.id=k.berth_id JOIN yachts y ON y.id=k.yacht_id
           WHERE k.status='escrowed' AND k.arrive <= CURRENT_DATE AND k.depart > CURRENT_DATE""")).mappings().all()
    s = get_settings()
    for r in due:
        sar = db.execute(text(
            """SELECT est_length_m FROM positions WHERE yacht_id=:y AND source='sar' AND est_length_m IS NOT NULL
                 AND observed_at > now() - make_interval(mins => :w) ORDER BY observed_at DESC LIMIT 1"""),
            {"y": r["yacht_id"], "w": s.fusion_window_minutes}).first()
        if sar:
            est, loa, cap = float(sar.est_length_m), float(r["loa_m"]), float(r["max_loa_m"])
            if est > cap * 1.05:
                if _log(db, "arrivals", r["ref"], "flagged",
                        f"Satellite measured a {est:.0f} m hull for {r['name']} arriving at berth {r['code']} (max {cap:g} m)",
                        {"marina_id": r["marina_id"], "berth": r["code"], "est_length_m": est}):
                    out["flags"] += 1
            elif abs(est - loa) > 0.2 * loa:
                if _log(db, "arrivals", r["ref"], "flagged",
                        f"Satellite hull estimate {est:.0f} m does not match {r['name']}'s registered {loa:g} m: possibly a different vessel",
                        {"marina_id": r["marina_id"], "berth": r["code"], "est_length_m": est}):
                    out["flags"] += 1
        try:
            res = prove_arrival(r["ref"], db)
        except HTTPException:
            continue
        if res.get("arrived"):
            out["arrivals_proven"] += 1
            _log(db, "arrivals", r["ref"], "done",
                 f"Arrival of {r['name']} at berth {r['code']} proven by {res.get('primary', 'gps')} plus an independent signal; "
                 "escrow is ready for release", {"marina_id": r["marina_id"], "berth": r["code"], "leaf": res.get("leaf")},
                 dedupe=False)

    # 4. registrations
    pend = db.execute(text(
        """SELECT c.user_id, u.name, c.vessel_name, c.screening FROM owner_claims c JOIN users u ON u.id=c.user_id
           WHERE u.status='pending'""")).mappings().all()
    for p in pend:
        prev = p["screening"] or {}
        res = screen_claim(db, p["user_id"])
        out["registrations_screened"] += 1
        used_ai = bool((res.get("ai") or {}).get("available"))
        failed = [c["msg"] for c in res["checks"] if not c["ok"]]
        summary = (f"{p['name']} ({p['vessel_name']}): every check passed, recommend approval" if not failed
                   else f"{p['name']} ({p['vessel_name']}): needs review: " + "; ".join(failed))
        # resolve an older open finding about this person if the verdict changed, then log the current one
        if prev.get("recommendation") and prev.get("recommendation") != res["recommendation"]:
            db.execute(text("UPDATE autopilot_log SET resolved=TRUE WHERE job='registrations' AND subject=:s"), {"s": str(p["user_id"])})
        _log(db, "registrations", str(p["user_id"]), res["recommendation"], summary, {"checks": res["checks"]}, used_ai)
        if s.autopilot_auto_approve and not failed:
            db.execute(text("UPDATE users SET status='active' WHERE id=:u AND status='pending'"), {"u": p["user_id"]})
            out["approved"] += 1
            _log(db, "registrations", str(p["user_id"]), "done", f"Approved {p['name']} automatically: every check passed",
                 dedupe=False)

    # 5. brief (AI, optional)
    if ai.enabled():
        open_flags = db.execute(text(
            "SELECT job, outcome, summary FROM autopilot_log WHERE NOT resolved AND outcome IN ('flagged','needs_review') "
            "ORDER BY at DESC LIMIT 40")).mappings().all()
        b = ai.write_brief([dict(f) for f in open_flags])
        if b.get("available"):
            out["brief"] = b
            _log(db, "brief", "", "info", b["headline"], {"actions": b["actions"]}, used_ai=True, dedupe=False)

    db.commit()
    _last_run.update(at=started, result=out)
    return out


@router.get("/admin/autopilot")
def overview(limit: int = Query(80, le=500), db: Session = Depends(get_db), who=Depends(require_right("autopilot"))):
    rows = db.execute(text("SELECT * FROM autopilot_log ORDER BY at DESC, id DESC LIMIT :n"), {"n": limit}).mappings().all()
    counts = db.execute(text(
        """SELECT count(*) FILTER (WHERE outcome='flagged' AND NOT resolved) AS open_flags,
                  count(*) FILTER (WHERE outcome='recommend_approve' AND NOT resolved) AS ready_to_approve,
                  count(*) FILTER (WHERE outcome='needs_review' AND NOT resolved) AS needs_review,
                  count(*) FILTER (WHERE at > now() - interval '24 hours' AND outcome='done') AS done_24h
           FROM autopilot_log""")).mappings().first()
    s = get_settings()
    return {"ai_enabled": ai.enabled(), "ai_model": s.ai_model if ai.enabled() else None,
            "interval_seconds": s.autopilot_interval_seconds, "auto_approve": s.autopilot_auto_approve,
            "last_run": _last_run or None, "counts": dict(counts), "log": [dict(r) for r in rows]}


@router.post("/admin/autopilot/run")
def run_now(db: Session = Depends(get_db), who=Depends(require_right("autopilot"))):
    return run(db)


@router.post("/admin/autopilot/{log_id}/resolve")
def resolve(log_id: int, db: Session = Depends(get_db), who=Depends(require_right("autopilot"))):
    n = db.execute(text("UPDATE autopilot_log SET resolved=TRUE WHERE id=:i"), {"i": log_id}).rowcount
    db.commit()
    if not n:
        raise HTTPException(404, "Not found")
    return {"resolved": True}


@router.post("/admin/autopilot/approve-recommended")
def approve_recommended(db: Session = Depends(get_db), who=Depends(require_right("autopilot", "users"))):
    """One click for the admin: approve every pending owner whose checks all passed."""
    ids = [r.user_id for r in db.execute(text(
        """SELECT c.user_id FROM owner_claims c JOIN users u ON u.id=c.user_id
           WHERE u.status='pending' AND c.screening->>'recommendation'='recommend_approve'"""))]
    for uid in ids:
        db.execute(text("UPDATE users SET status='active' WHERE id=:u"), {"u": uid})
        db.execute(text("UPDATE autopilot_log SET resolved=TRUE WHERE job='registrations' AND subject=:s"), {"s": str(uid)})
    if ids:
        _log(db, "registrations", "", "done", f"Admin approved {len(ids)} owner{'s' if len(ids) != 1 else ''} the autopilot recommended",
             {"user_ids": ids}, dedupe=False)
    db.commit()
    return {"approved": ids}
