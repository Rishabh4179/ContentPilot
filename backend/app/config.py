"""Application configuration loaded from environment variables."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    gemini_embedding_model: str = "gemini-embedding-001"
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    groq_compound_model: str = "groq/compound-mini"
    gemini_image_model: str = "gemini-2.5-flash-image"
    # Image provider: "pollinations" (free, no key), "cloudflare" (free FLUX.1 via a
    # free Cloudflare token), or "gemini" (Nano Banana, low free quota).
    image_provider: str = "pollinations"
    pollinations_model: str = "flux"
    pollinations_token: str = ""
    # Run Pollinations' built-in LLM prompt enhancer for sharper, more on-topic images
    # (free, keyless). Set POLLINATIONS_ENHANCE=false to disable.
    pollinations_enhance: bool = True
    # Cloudflare Workers AI — free tier gives high-quality FLUX.1-schnell images.
    # Create a free token + account id at dash.cloudflare.com (Workers AI) and set
    # IMAGE_PROVIDER=cloudflare to use it.
    cloudflare_account_id: str = ""
    cloudflare_api_token: str = ""
    cloudflare_image_model: str = "@cf/black-forest-labs/flux-1-schnell"
    cloudflare_image_steps: int = 8
    # Supabase Storage for generated images. Images are uploaded here and served
    # from a public URL, so they survive redeploys and work on serverless hosts like
    # Vercel (which have an ephemeral, read-only filesystem). Create a project + a
    # PUBLIC storage bucket at supabase.com; the service-role key is under
    # Project Settings → API. No card required.
    supabase_url: str = ""  # e.g. https://xxxxxxxx.supabase.co
    supabase_service_key: str = ""  # service_role key (server-side only, keep secret)
    supabase_bucket: str = ""  # the public bucket name, e.g. "images"
    # Postgres/Neon connection string (required — no SQLite fallback), e.g.
    # postgresql://user:pass@host/db?sslmode=require
    database_url: str = ""
    clerk_publishable_key: str = ""
    clerk_secret_key: str = ""
    clerk_jwks_url: str = ""
    clerk_issuer: str = ""
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Email delivery.
    # PREFERRED (works on any host incl. serverless — sends over HTTPS, never
    # blocked): Resend HTTP API. Set RESEND_API_KEY + RESEND_FROM to enable.
    resend_api_key: str = ""
    # From address for Resend, e.g. "ContentPilot <noreply@yourdomain.com>".
    # Use "onboarding@resend.dev" to test before verifying a domain. Falls back to
    # SMTP_FROM_NAME + SMTP_FROM when blank.
    resend_from: str = ""
    # FALLBACK: raw SMTP (Gmail app password, Outlook, Mailgun…). NOTE: many hosts
    # block outbound SMTP ports (Render/Vercel), so prefer Resend in production.
    # Leave both resend_api_key and smtp_host empty to keep email disabled
    # (endpoints return previews).
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""  # defaults to smtp_user when blank
    smtp_from_name: str = "ContentPilot"
    smtp_use_tls: bool = True
    # Public URL of the frontend, used for links/buttons in emails.
    app_base_url: str = "http://localhost:5173"
    # Public URL of this backend, used for one-click unsubscribe links.
    api_base_url: str = "http://localhost:8000"

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
