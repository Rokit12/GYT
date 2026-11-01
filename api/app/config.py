from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Any PostgreSQL 15+ with PostGIS. For an always-on hosted database, paste the provider's URL here
    # (keep ?sslmode=require). See README "Hosting the database".
    database_url: str = "postgresql+psycopg://gyt:gyt@localhost:5432/gyt"
    db_pooler: str = ""              # "transaction" for PgBouncer/Supavisor transaction mode (auto for port 6543)
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_pool_recycle: int = 280       # seconds; below typical idle-drop limits of hosts and load balancers
    db_connect_timeout: int = 10
    db_wait_seconds: int = 60        # how long startup waits for the database to answer
    auto_migrate: bool = False       # true = API applies pending migrations at startup (handy locally)
    # Service token for simulators, schedulers and CI. Empty disables it.
    admin_token: str = ""
    # Sessions
    jwt_secret: str = ""
    jwt_ttl_minutes: int = 12 * 60
    # First admin account, created by `python -m app.seed` when both are set
    admin_email: str | None = None
    admin_password: str | None = None
    cors_origins: str = "http://localhost:3000"

    # Proof anchoring
    anchor_interval_seconds: int = 600  # 10 minutes; architecture targets 5-15
    chain_rpc: str | None = None  # e.g. http://anvil:8545 or an L2 RPC
    anchor_private_key: str | None = None
    proof_registry_address: str | None = None
    yacht_twin_address: str | None = None
    arrival_escrow_address: str | None = None
    identity_registry_address: str | None = None

    # 64 hex chars (32 bytes). Encrypts bank account numbers at rest.
    bank_data_key: str | None = None

    # Fusion thresholds
    fusion_window_minutes: int = 45  # observations must be this recent to count
    fusion_max_spread_m: int = 1500  # max distance between sources to agree

    # Software tracking from a signed-in phone or laptop (no hardware GPS needed)
    device_tracking_enabled: bool = True
    device_max_accuracy_m: float = 1000  # fixes vaguer than this are refused
    device_good_accuracy_m: float = 100  # fixes at least this precise count as "good"
    device_min_interval_s: int = 10  # store at most one fix per session this often
    device_max_speed_kn: float = 60  # faster jumps between fixes are stored but flagged
    device_counts_for_arrival: bool = True  # a good device fix may stand in for signed GPS (needs AIS or SAR too)

    # Berth finding
    berth_hold_minutes: int = 10  # how long a yacht can hold a berth while the owner confirms
    berth_snug_margin_m: float = 1.0  # a fit with less spare length than this is shown as "snug"

    # Who can create an account: "owners_and_invites" (yacht owners with proof, or invited people) or "open"
    registration_mode: str = "owners_and_invites"
    invite_days: int = 14

    # Autopilot: automated checks. AI (Claude) is optional and only advises; the rules decide.
    autopilot_interval_seconds: int = 120  # 0 = only when an admin presses Run
    autopilot_auto_approve: bool = False  # approve owners automatically when every check passes
    anthropic_api_key: str = ""
    ai_model: str = "claude-sonnet-5-5"

    # Use or Earn
    credit_rate: float = 0.06
    holder_discount: float = 0.85
    earn_share: float = 0.80
    earn_occupancy: float = 0.70

    # External data (all optional; adapters no-op without keys)
    aishub_username: str | None = None
    gfw_api_token: str | None = None  # Global Fishing Watch
    osiris_endpoint: str | None = None  # CNR-ISTI OSIRIS deployment, via research partnership
    kyc_provider_key: str | None = None

    # Uploaded yacht photos are stored here (mount a volume in production)
    media_dir: str = "media"
    photo_storage: str = "db"        # "db" keeps photo bytes in the database, so the API holds no state

    # Live AIS for the maps: aisstream.io (free key at https://aisstream.io/authenticate)
    aisstream_api_key: str | None = None
    aisstream_url: str = "wss://stream.aisstream.io/v0/stream"
    live_box_deg: float = 0.5  # half-size of the box watched around each partner marina
    # Digitraffic (Finland): open AIS, no key, CC BY 4.0. Set DIGITRAFFIC_ENABLED=false to turn off.
    digitraffic_enabled: bool = True
    digitraffic_url: str = "https://meri.digitraffic.fi"
    digitraffic_user: str = "GYT/0.3"
    digitraffic_poll_seconds: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()
