"""Database models and article schemas."""
import secrets
from datetime import datetime, timezone

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def _new_token() -> str:
    return secrets.token_urlsafe(24)


class ArticleCreate(SQLModel):
    """Payload for saving a generated article to the library."""

    topic: str
    keywords: list[str] = Field(default_factory=list)
    tone: str = "informative"
    length: str = "medium"
    audience: str = "a general audience"
    title: str
    meta_description: str = ""
    markdown: str
    word_count: int = 0
    provider: str = "gemini"


class Article(SQLModel, table=True):
    """A persisted, generated article."""

    id: int | None = Field(default=None, primary_key=True)
    user_id: str = Field(default="local", index=True)
    topic: str
    keywords: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    tone: str = "informative"
    length: str = "medium"
    audience: str = "a general audience"
    title: str
    meta_description: str = ""
    markdown: str
    word_count: int = 0
    provider: str = "gemini"
    cover_url: str | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc), index=True
    )


class ArticleRead(ArticleCreate):
    """Article returned to the client."""

    id: int
    created_at: datetime
    cover_url: str | None = None


class ArticleUpdate(SQLModel):
    """Partial update for a saved article."""

    title: str | None = None
    meta_description: str | None = None
    markdown: str | None = None
    word_count: int | None = None
    cover_url: str | None = None


class ArticleEmbedding(SQLModel, table=True):
    """Cached vector embedding for an article, used for library RAG search.

    Kept in a separate table so the Article row stays lean (list/stats queries
    don't load big vectors). `content_hash` lets us skip re-embedding unchanged
    articles and re-embed edited ones lazily."""

    id: int | None = Field(default=None, primary_key=True)
    article_id: int = Field(index=True, unique=True)
    user_id: str = Field(default="local", index=True)
    model: str = ""
    content_hash: str = ""
    vector: list[float] = Field(default_factory=list, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DigestSubscription(SQLModel, table=True):
    """A user's opt-in to the recurring email digest.

    One row per user_id. `enabled` toggles delivery; `unsubscribe_token` powers
    the one-click unsubscribe link embedded in every email (no auth needed)."""

    id: int | None = Field(default=None, primary_key=True)
    user_id: str = Field(index=True, unique=True)
    email: str
    name: str = ""
    enabled: bool = True
    frequency: str = "weekly"  # weekly (extensible: daily / monthly)
    send_day: int = 0  # 0=Monday … 6=Sunday (Python weekday())
    send_hour: int = 9  # 0–23, interpreted in `timezone`
    timezone: str = "UTC"  # IANA name, e.g. "Asia/Kolkata"
    unsubscribe_token: str = Field(default_factory=_new_token, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_sent_at: datetime | None = None


class ChatSession(SQLModel, table=True):
    """One saved chat conversation (a "session").

    Multiple sessions exist per user + mode + article, ChatGPT-style. `mode` is
    "agent" (task chat about one article) or "library" (RAG Q&A across the whole
    library; article_id = 0). The full message list is stored as JSON so the rich
    frontend shapes (steps, sources, results) round-trip intact. `title` is
    auto-derived from the first user message."""

    id: int | None = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    mode: str = Field(default="agent", index=True)  # "agent" | "library"
    article_id: int = Field(default=0, index=True)  # 0 == library / global
    title: str = "New chat"
    messages: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
