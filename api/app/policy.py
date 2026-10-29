"""Off-chain mirrors of on-chain rules, used to explain results to people before they sign.

The contracts remain the source of truth: preflight results here must never be used to skip
the on-chain check.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass
class Check:
    rule: str
    ok: bool
    detail: str


@dataclass
class InvestorView:
    kyc_status: str
    screening: str
    country_code: int
    professional: bool
    kyc_expires: date | None


def transfer_checks(
    buyer: InvestorView,
    units: int,
    buyer_balance: int,
    total_supply: int,
    allowed_countries: list[int],
    professional_max_bps: int,
    retail_max_bps: int,
    lockup_until: datetime | None,
    now: datetime | None = None,
) -> list[Check]:
    now = now or datetime.now(timezone.utc)
    after = buyer_balance + units
    cap = professional_max_bps if buyer.professional else retail_max_bps
    share_bps = after * 10_000 / total_supply if total_supply else 0
    kyc_live = buyer.kyc_status == "approved" and (buyer.kyc_expires is None or buyer.kyc_expires > now.date())
    return [
        Check("IDENTITY_VERIFIED", kyc_live, "KYC approved and current" if kyc_live else f"KYC is {buyer.kyc_status}"),
        Check("SCREENING_CLEAR", buyer.screening == "clear", buyer.screening.replace("_", " ")),
        Check(
            "COUNTRY_ALLOWED",
            buyer.country_code in allowed_countries,
            f"ISO {buyer.country_code} {'is' if buyer.country_code in allowed_countries else 'is not'} on this SPV's list",
        ),
        Check("HOLDING_CAP", share_bps <= cap, f"{share_bps / 100:.2f}% after transfer vs {cap / 100:.2f}% cap"),
        Check(
            "LOCKUP",
            lockup_until is None or now >= lockup_until,
            "No lock-up active" if lockup_until is None or now >= lockup_until else f"Locked until {lockup_until:%Y-%m-%d}",
        ),
    ]


# ---------------- Use or Earn ----------------


@dataclass
class HoldingView:
    yacht_id: str
    units: int
    units_total: int
    valuation_usd: float
    mode: str  # use | earn


def stake_usd(h: HoldingView) -> float:
    return h.valuation_usd * h.units / h.units_total if h.units_total else 0.0


def credit_summary(holdings: list[HoldingView], spent_usd: float, rate: float, discount: float, share: float, occ: float):
    use = sum(stake_usd(h) * rate for h in holdings if h.mode == "use")
    earn = sum(stake_usd(h) * rate for h in holdings if h.mode == "earn")
    return {
        "stake_usd": round(sum(stake_usd(h) for h in holdings), 2),
        "use_credits_usd": round(use, 2),
        "use_credits_left_usd": round(max(0.0, use - spent_usd), 2),
        "earn_pool_usd": round(earn, 2),
        # pooled nights sell at full price (credits are valued at the holder discount)
        "earn_payout_est_usd": round(earn / discount * share * occ, 2),
    }


def stay_cost(charter_week_usd: float, nights: int, discount: float) -> float:
    return round(charter_week_usd / 7 * discount * nights, 2)


# ---------------- Condition score ----------------


def condition_score(
    inspection_status: str,
    insurance_verified: bool,
    ais_gaps_90d: int,
    year_built: int | None,
    service_logs_12m: int,
    current_year: int,
) -> tuple[int, list[tuple[str, int]]]:
    s, f = 100, []
    if inspection_status == "PENDING":
        s -= 15
        f.append(("Inspection pending", -15))
    elif inspection_status != "VALID":
        s -= 8
        f.append(("Inspection due soon", -8))
    if not insurance_verified:
        s -= 20
        f.append(("Insurance not verified", -20))
    g = min(ais_gaps_90d, 4)
    if g:
        s -= 3 * g
        f.append((f"{ais_gaps_90d} AIS gaps in 90 days", -3 * g))
    if year_built:
        age = current_year - year_built
        if age > 8:
            p = min(10, age - 8)
            s -= p
            f.append((f"Hull age {age} years", -p))
    if service_logs_12m:
        b = min(5, service_logs_12m)
        s += b
        f.append((f"{service_logs_12m} verified service logs", b))
    return max(0, min(100, s)), f
