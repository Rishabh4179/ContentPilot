"""CRUD endpoints for the saved-articles library (scoped to the current user)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..auth import get_current_user_id
from ..db import get_session
from ..models import Article, ArticleCreate, ArticleRead, ArticleUpdate

router = APIRouter(prefix="/api/articles", tags=["articles"])


@router.get("", response_model=list[ArticleRead])
def list_articles(
    limit: int = 50,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> list[Article]:
    return session.exec(
        select(Article)
        .where(Article.user_id == user_id)
        .order_by(Article.created_at.desc())
        .limit(limit)
    ).all()


@router.post("", response_model=ArticleRead, status_code=201)
def create_article(
    payload: ArticleCreate,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> Article:
    article = Article(**payload.model_dump(), user_id=user_id)
    session.add(article)
    session.commit()
    session.refresh(article)
    return article


@router.get("/{article_id}", response_model=ArticleRead)
def get_article(
    article_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> Article:
    article = session.get(Article, article_id)
    if not article or article.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")
    return article


@router.put("/{article_id}", response_model=ArticleRead)
def update_article(
    article_id: int,
    payload: ArticleUpdate,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> Article:
    article = session.get(Article, article_id)
    if not article or article.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(article, key, value)
    session.add(article)
    session.commit()
    session.refresh(article)
    return article


@router.delete("/{article_id}", status_code=204)
def delete_article(
    article_id: int,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> None:
    article = session.get(Article, article_id)
    if not article or article.user_id != user_id:
        raise HTTPException(status_code=404, detail="Article not found")
    session.delete(article)
    session.commit()


@router.delete("", status_code=204)
def clear_articles(
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> None:
    for article in session.exec(select(Article).where(Article.user_id == user_id)).all():
        session.delete(article)
    session.commit()
