"""Dashboard analytics — aggregates the user's saved articles into stats.

Everything is computed in Python from the user's Article rows, avoiding
dialect-specific date functions. For a personal library (hundreds–low-thousands
of rows) this is fast and simple.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..auth import get_current_user_id
from ..db import get_session
from ..models import Article
from ..schemas import NameCount, StatPoint, StatsResponse

router = APIRouter(prefix="/api/stats", tags=["stats"])

# How many trailing days to include in the activity chart.
_OVER_TIME_DAYS = 30
# How many top keywords to surface.
_TOP_KEYWORDS = 12


def _as_utc(dt: datetime) -> datetime:
    """Normalise a possibly-naive datetime to aware UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@router.get("", response_model=StatsResponse)
def get_stats(
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> StatsResponse:
    rows = session.exec(
        select(Article).where(Article.user_id == user_id)
    ).all()

    if not rows:
        return StatsResponse()

    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    two_weeks_ago = now - timedelta(days=14)

    total_articles = len(rows)
    total_words = sum(int(a.word_count or 0) for a in rows)
    longest_words = max(int(a.word_count or 0) for a in rows)
    avg_words = round(total_words / total_articles) if total_articles else 0

    articles_this_week = 0
    words_this_week = 0
    articles_prev_week = 0
    active_dates: set[str] = set()

    # Daily buckets for the trailing window.
    day_counts: Counter[str] = Counter()
    day_words: Counter[str] = Counter()

    keyword_counter: Counter[str] = Counter()
    audience_counter: Counter[str] = Counter()
    tone_counter: Counter[str] = Counter()
    length_counter: Counter[str] = Counter()

    window_start = (now - timedelta(days=_OVER_TIME_DAYS - 1)).date()

    for a in rows:
        created = _as_utc(a.created_at)
        d = created.date()
        active_dates.add(d.isoformat())

        if created >= week_ago:
            articles_this_week += 1
            words_this_week += int(a.word_count or 0)
        elif created >= two_weeks_ago:
            articles_prev_week += 1

        if d >= window_start:
            key = d.isoformat()
            day_counts[key] += 1
            day_words[key] += int(a.word_count or 0)

        for kw in a.keywords or []:
            k = str(kw).strip().lower()
            if k:
                keyword_counter[k] += 1

        audience_counter[(a.audience or "unknown").strip() or "unknown"] += 1
        tone_counter[(a.tone or "unknown").strip() or "unknown"] += 1
        length_counter[(a.length or "unknown").strip() or "unknown"] += 1

    # Build a contiguous day series (fill gaps with zeros) for a clean chart.
    over_time: list[StatPoint] = []
    for i in range(_OVER_TIME_DAYS):
        day = window_start + timedelta(days=i)
        key = day.isoformat()
        over_time.append(
            StatPoint(
                label=day.strftime("%b %d"),
                count=day_counts.get(key, 0),
                words=day_words.get(key, 0),
            )
        )

    def _top(counter: Counter[str], n: int | None = None) -> list[NameCount]:
        items = counter.most_common(n)
        return [NameCount(name=name, count=count) for name, count in items]

    return StatsResponse(
        total_articles=total_articles,
        total_words=total_words,
        avg_words=avg_words,
        longest_words=longest_words,
        articles_this_week=articles_this_week,
        words_this_week=words_this_week,
        articles_prev_week=articles_prev_week,
        active_days=len(active_dates),
        over_time=over_time,
        top_keywords=_top(keyword_counter, _TOP_KEYWORDS),
        audiences=_top(audience_counter, 8),
        tones=_top(tone_counter),
        lengths=_top(length_counter),
    )
