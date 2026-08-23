"""Persisted chat sessions — ChatGPT-style history, independent per mode.

Two conversation kinds, each with MANY sessions:
  * mode="agent"   → task chats about a single article (article_id = that id)
  * mode="library" → RAG Q&A across the whole library (article_id = 0)

Each session stores its whole message list as JSON (blob-per-session), so the
rich frontend message shapes — agent tool steps, RAG sources, result cards —
round-trip without per-type DB modeling. Titles are auto-derived from the first
user message.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..auth import get_current_user_id
from ..db import get_session
from ..models import ChatSession
from ..schemas import (
    ChatSessionCreate,
    ChatSessionDetail,
    ChatSessionMeta,
    ChatSessionRename,
    ChatSessionUpdate,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])

_MODES = {"agent", "library"}
_MAX_MESSAGES = 300


def _norm(mode: str, article_id: int) -> tuple[str, int]:
    mode = (mode or "agent").strip().lower()
    if mode not in _MODES:
        raise HTTPException(status_code=422, detail="mode must be 'agent' or 'library'.")
    aid = 0 if mode == "library" else int(article_id or 0)
    return mode, aid


def _auto_title(messages: list) -> str:
    """Title from the first user message, trimmed."""
    for m in messages or []:
        if isinstance(m, dict) and m.get("role") == "user":
            text = str(m.get("content") or "").strip().replace("\n", " ")
            if text:
                return text[:60] + ("…" if len(text) > 60 else "")
    return "New chat"


def _count(messages: list) -> int:
    return sum(
        1
        for m in (messages or [])
        if isinstance(m, dict) and m.get("role") in {"user", "assistant"}
    )


def _iso(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


def _owned(session: Session, session_id: int, user_id: str) -> ChatSession:
    row = session.get(ChatSession, session_id)
    if not row or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="Chat session not found.")
    return row


@router.get("/sessions", response_model=list[ChatSessionMeta])
def list_sessions(
    mode: str = Query("agent"),
    article_id: int = Query(0),
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> list[ChatSessionMeta]:
    mode, aid = _norm(mode, article_id)
    rows = session.exec(
        select(ChatSession)
        .where(
            ChatSession.user_id == user_id,
            ChatSession.mode == mode,
            ChatSession.article_id == aid,
        )
        .order_by(ChatSession.updated_at.desc())
    ).all()
    return [
        ChatSessionMeta(
            id=r.id,
            mode=r.mode,
            article_id=r.article_id,
            title=r.title,
            message_count=_count(r.messages),
            updated_at=_iso(r.updated_at),
        )
        for r in rows
    ]


@router.get("/sessions/{session_id}", response_model=ChatSessionDetail)
def get_session_detail(
    session_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> ChatSessionDetail:
    r = _owned(session, session_id, user_id)
    return ChatSessionDetail(
        id=r.id,
        mode=r.mode,
        article_id=r.article_id,
        title=r.title,
        messages=r.messages or [],
        updated_at=_iso(r.updated_at),
    )


@router.post("/sessions", response_model=ChatSessionDetail, status_code=201)
def create_session(
    req: ChatSessionCreate,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> ChatSessionDetail:
    mode, aid = _norm(req.mode, req.article_id)
    messages = req.messages if isinstance(req.messages, list) else []
    if len(messages) > _MAX_MESSAGES:
        messages = messages[-_MAX_MESSAGES:]
    row = ChatSession(
        user_id=user_id,
        mode=mode,
        article_id=aid,
        title=_auto_title(messages),
        messages=messages,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return ChatSessionDetail(
        id=row.id,
        mode=row.mode,
        article_id=row.article_id,
        title=row.title,
        messages=row.messages or [],
        updated_at=_iso(row.updated_at),
    )


@router.put("/sessions/{session_id}", response_model=ChatSessionDetail)
def update_session(
    session_id: int,
    req: ChatSessionUpdate,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> ChatSessionDetail:
    row = _owned(session, session_id, user_id)
    messages = req.messages if isinstance(req.messages, list) else []
    if len(messages) > _MAX_MESSAGES:
        messages = messages[-_MAX_MESSAGES:]
    row.messages = messages
    # Keep the auto-title fresh until the user renames it manually.
    if not row.title or row.title == "New chat":
        row.title = _auto_title(messages)
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ChatSessionDetail(
        id=row.id,
        mode=row.mode,
        article_id=row.article_id,
        title=row.title,
        messages=row.messages or [],
        updated_at=_iso(row.updated_at),
    )


@router.patch("/sessions/{session_id}", response_model=ChatSessionMeta)
def rename_session(
    session_id: int,
    req: ChatSessionRename,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> ChatSessionMeta:
    row = _owned(session, session_id, user_id)
    row.title = req.title.strip()[:120]
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ChatSessionMeta(
        id=row.id,
        mode=row.mode,
        article_id=row.article_id,
        title=row.title,
        message_count=_count(row.messages),
        updated_at=_iso(row.updated_at),
    )


@router.delete("/sessions/{session_id}")
def delete_session(
    session_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> dict:
    row = _owned(session, session_id, user_id)
    session.delete(row)
    session.commit()
    return {"ok": True}
