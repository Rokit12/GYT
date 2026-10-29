from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://gyt:gyt@localhost:5432/gyt"
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
