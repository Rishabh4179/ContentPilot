"""Database engine and session management (SQLModel; Postgres / Neon only)."""
from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from .config import get_settings

_settings = get_settings()


def _resolve_url(url: str) -> str:
    """Normalize a Postgres DATABASE_URL. Raw `postgresql://` (and the legacy
    `postgres://`) are upgraded to `postgresql+psycopg://` so SQLAlchemy picks
    psycopg 3 instead of the missing psycopg2 driver. Raises if no Postgres URL
    is configured — this app requires Postgres/Neon (no SQLite fallback)."""
    url = (url or "").strip()
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. This app requires a Postgres/Neon connection "
            "string, e.g. postgresql://user:pass@host/db?sslmode=require"
        )
    if url.startswith("postgresql+"):
        return url
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    raise RuntimeError(
        f"Unsupported DATABASE_URL: {url!r}. A Postgres/Neon URL is required "
        "(postgresql://…). SQLite is no longer supported."
    )


_database_url = _resolve_url(_settings.database_url)
# Postgres over the network benefits from pre-ping (drops stale idle conns that
# Neon closes after a few minutes of inactivity).
engine = create_engine(_database_url, echo=False, pool_pre_ping=True)


def init_db() -> None:
    """Create tables. Importing models registers them on SQLModel.metadata."""
    from . import models  # noqa: F401  (ensures models are registered)

    SQLModel.metadata.create_all(engine)
    _ensure_columns()


def _ensure_columns() -> None:
    """Add columns introduced after a table already existed. `create_all()`
    creates NEW tables but never ALTERs existing ones, so new fields on an
    established table need a small migration. Uses the SQLAlchemy inspector."""
    from sqlalchemy import inspect

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    def _cols(table: str) -> set[str]:
        return {c["name"] for c in inspector.get_columns(table)}

    with engine.begin() as conn:
        if "article" in tables:
            existing = _cols("article")
            if "user_id" not in existing:
                conn.exec_driver_sql(
                    "ALTER TABLE article ADD COLUMN user_id VARCHAR DEFAULT 'local'"
                )
            if "cover_url" not in existing:
                conn.exec_driver_sql("ALTER TABLE article ADD COLUMN cover_url VARCHAR")
        if "digestsubscription" in tables:
            existing = _cols("digestsubscription")
            if "send_day" not in existing:
                conn.exec_driver_sql(
                    "ALTER TABLE digestsubscription ADD COLUMN send_day INTEGER DEFAULT 0"
                )
            if "send_hour" not in existing:
                conn.exec_driver_sql(
                    "ALTER TABLE digestsubscription ADD COLUMN send_hour INTEGER DEFAULT 9"
                )
            if "timezone" not in existing:
                conn.exec_driver_sql(
                    "ALTER TABLE digestsubscription ADD COLUMN timezone VARCHAR DEFAULT 'UTC'"
                )
        # The single-thread `chatthread` table was superseded by multi-session
        # `chatsession`. It was empty (brand new), so drop it if present.
        if "chatthread" in tables:
            conn.exec_driver_sql("DROP TABLE IF EXISTS chatthread")


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
