"""Chat with your library — retrieval-augmented Q&A over saved articles.

Embeddings are cached in a separate table and computed lazily: on each ask we
embed any article that's new or whose content changed (detected via a content
hash), then rank all of the user's articles against the question by cosine
similarity and feed the top matches to the LLM. This keeps the write path
untouched — no embedding work happens on article save.

Similarity is computed in Python. For a personal library (tens–hundreds of
articles) this is fast and dependency-free; pgvector would be the drop-in
upgrade for much larger scales.
"""
from __future__ import annotations

import hashlib
import math

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user_id
from ..db import get_session
from ..models import Article, ArticleEmbedding
from ..schemas import (
    InternalLinkRequest,
    InternalLinkResponse,
    InternalLinkSuggestion,
    LibraryAskRequest,
    LibraryAskResponse,
    LibrarySource,
)

router = APIRouter(prefix="/api/library", tags=["library"])


def _embed_text_for(article: Article) -> str:
    """The text we embed for an article: title + topic + body (trimmed)."""
    parts = [
        article.title or "",
        article.topic or "",
        ", ".join(article.keywords or []),
        article.markdown or "",
    ]
    return "\n".join(p for p in parts if p).strip()


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()


def _snippet(markdown: str, limit: int = 900) -> str:
    text = (markdown or "").strip()
    # Drop a leading H1 so the snippet starts with real content.
    if text.startswith("#"):
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1 :].lstrip()
    return text[:limit]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _sync_embeddings(
    session: Session, user_id: str, articles: list[Article], generator
) -> tuple[dict[int, ArticleEmbedding], int]:
    """Ensure every article has a current embedding row; return (by_id, indexed).

    Re-embeds only articles that are new or whose content changed (content-hash),
    or whose stored model differs from the configured one. Shared by /ask and
    /internal-links so the embedding cache is built once and reused.
    """
    existing = {
        e.article_id: e
        for e in session.exec(
            select(ArticleEmbedding).where(ArticleEmbedding.user_id == user_id)
        ).all()
    }
    model = generator.settings.gemini_embedding_model
    to_embed: list[Article] = []
    hashes: dict[int, str] = {}
    for a in articles:
        text = _embed_text_for(a)
        h = _content_hash(text)
        hashes[a.id] = h
        row = existing.get(a.id)
        if row is None or row.content_hash != h or not row.vector or row.model != model:
            to_embed.append(a)

    indexed = 0
    if to_embed:
        vectors = generator.embed_texts([_embed_text_for(a) for a in to_embed])
        for a, vec in zip(to_embed, vectors):
            row = existing.get(a.id)
            if row is None:
                row = ArticleEmbedding(article_id=a.id, user_id=user_id)
                existing[a.id] = row
            row.model = model
            row.content_hash = hashes[a.id]
            row.vector = vec
            session.add(row)
            indexed += 1
        session.commit()
    return existing, indexed



@router.post("/ask", response_model=LibraryAskResponse)
def ask_library(
    req: LibraryAskRequest,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> LibraryAskResponse:
    from ..main import generator  # local import avoids a circular import at load

    articles = session.exec(
        select(Article).where(Article.user_id == user_id)
    ).all()
    if not articles:
        return LibraryAskResponse(
            answer="Your library is empty — generate a few articles and then I can "
            "answer questions about them.",
            sources=[],
            indexed=0,
        )

    # Existing embeddings for this user, keyed by article id.
    existing = {
        e.article_id: e
        for e in session.exec(
            select(ArticleEmbedding).where(ArticleEmbedding.user_id == user_id)
        ).all()
    }

    model = generator.settings.gemini_embedding_model

    # Figure out which articles need (re)embedding.
    to_embed: list[Article] = []
    hashes: dict[int, str] = {}
    for a in articles:
        text = _embed_text_for(a)
        h = _content_hash(text)
        hashes[a.id] = h
        row = existing.get(a.id)
        if row is None or row.content_hash != h or not row.vector or row.model != model:
            to_embed.append(a)

    indexed = 0
    if to_embed:
        try:
            vectors = generator.embed_texts([_embed_text_for(a) for a in to_embed])
        except Exception as exc:  # noqa: BLE001 - surface a clear message
            raise HTTPException(
                status_code=502,
                detail=f"Could not build embeddings: {exc}",
            ) from exc
        for a, vec in zip(to_embed, vectors):
            row = existing.get(a.id)
            if row is None:
                row = ArticleEmbedding(article_id=a.id, user_id=user_id)
                existing[a.id] = row
            row.model = model
            row.content_hash = hashes[a.id]
            row.vector = vec
            session.add(row)
            indexed += 1
        session.commit()

    # Embed the question.
    try:
        q_vec = generator.embed_text(req.question)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Could not embed the question: {exc}"
        ) from exc

    # Rank all articles by cosine similarity.
    scored: list[tuple[float, Article]] = []
    for a in articles:
        row = existing.get(a.id)
        if not row or not row.vector:
            continue
        scored.append((_cosine(q_vec, row.vector), a))
    scored.sort(key=lambda t: t[0], reverse=True)
    top = scored[: req.top_k]

    contexts = [
        {"title": a.title or a.topic or "Untitled", "snippet": _snippet(a.markdown)}
        for _score, a in top
    ]
    answer, provider = generator.answer_library_question(req.question, contexts)

    sources = [
        LibrarySource(
            id=a.id,
            title=a.title or a.topic or "Untitled",
            topic=a.topic or "",
            score=round(float(score), 4),
        )
        for score, a in top
    ]
    return LibraryAskResponse(
        answer=answer, sources=sources, provider=provider, indexed=indexed
    )


@router.post("/internal-links", response_model=InternalLinkResponse)
def internal_links(
    req: InternalLinkRequest,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> InternalLinkResponse:
    """Suggest internal links from one article to the user's OTHER articles.

    Ranks the rest of the library against the current article by embedding
    similarity, then asks the LLM to pick natural anchor phrases (that appear in
    the article) for the most relevant targets — a strong on-site SEO signal.
    """
    from ..main import generator  # local import avoids a circular import at load

    current = session.get(Article, req.article_id)
    if not current or current.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")

    articles = session.exec(
        select(Article).where(Article.user_id == user_id)
    ).all()
    others = [a for a in articles if a.id != current.id]
    if not others:
        return InternalLinkResponse(
            suggestions=[],
            provider="",
            indexed=0,
        )

    try:
        by_id, indexed = _sync_embeddings(session, user_id, articles, generator)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Could not build embeddings: {exc}"
        ) from exc

    cur_row = by_id.get(current.id)
    if not cur_row or not cur_row.vector:
        return InternalLinkResponse(suggestions=[], provider="", indexed=indexed)

    scored: list[tuple[float, Article]] = []
    for a in others:
        row = by_id.get(a.id)
        if not row or not row.vector:
            continue
        scored.append((_cosine(cur_row.vector, row.vector), a))
    scored.sort(key=lambda t: t[0], reverse=True)
    # Consider a few more than requested; the LLM will drop poor fits.
    top = scored[: max(req.max_suggestions + 3, req.max_suggestions)]

    candidates = [
        {"id": a.id, "title": a.title or a.topic or "Untitled", "topic": a.topic or ""}
        for _s, a in top
    ]
    score_by_id = {a.id: s for s, a in top}
    title_by_id = {a.id: (a.title or a.topic or "Untitled") for _s, a in top}
    topic_by_id = {a.id: (a.topic or "") for _s, a in top}

    raw, provider = generator.suggest_internal_links(
        markdown=current.markdown, candidates=candidates
    )
    suggestions = [
        InternalLinkSuggestion(
            target_id=item["target_id"],
            target_title=title_by_id.get(item["target_id"], ""),
            target_topic=topic_by_id.get(item["target_id"], ""),
            anchor_text=item["anchor_text"],
            reason=item.get("reason", ""),
            score=round(float(score_by_id.get(item["target_id"], 0.0)), 4),
        )
        for item in raw[: req.max_suggestions]
    ]
    return InternalLinkResponse(
        suggestions=suggestions, provider=provider, indexed=indexed
    )

