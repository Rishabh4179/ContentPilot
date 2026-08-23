"""Email notifications — weekly digest + test email.

Reuses the dashboard stats aggregation to build a "your week in ContentPilot"
summary. When SMTP isn't configured (or preview=true), the endpoints return the
rendered HTML instead of sending, so the feature is usable before you add creds.
"""
from __future__ import annotations

import html as html_lib
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlmodel import Session, select

from ..auth import get_current_user_id
from ..config import get_settings
from ..db import get_session
from ..models import Article, DigestSubscription
from ..schemas import (
    NotifyRequest,
    NotifyResult,
    NotifyStatusResponse,
    StatsResponse,
    SubscriptionRequest,
    SubscriptionResponse,
)
from ..services.mailer import Mailer
from .stats import get_stats

router = APIRouter(prefix="/api/notify", tags=["notify"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Palette (kept in sync with the app's Midnight theme for a consistent look).
_C_BG = "#0b1120"
_C_CARD = "#151e31"
_C_CARD2 = "#1b2740"
_C_BORDER = "#263248"
_C_TEXT = "#e6ebf5"
_C_MUTED = "#93a1b8"
_C_ACCENT = "#6366f1"
_C_ACCENT2 = "#8b5cf6"


def _mailer() -> Mailer:
    return Mailer(get_settings())


def _app_url() -> str:
    s = get_settings()
    url = (s.app_base_url or "").strip()
    if not url and s.origins_list:
        url = s.origins_list[0]
    return url.rstrip("/")


def _unsub_url(token: str) -> str:
    """Public one-click unsubscribe link (hits this backend, no auth)."""
    if not token:
        return ""
    base = (get_settings().api_base_url or "").strip().rstrip("/")
    return f"{base}/api/notify/unsubscribe?token={token}" if base else ""


def _recent_articles(session: Session, user_id: str, limit: int = 5) -> list[Article]:
    return session.exec(
        select(Article)
        .where(Article.user_id == user_id)
        .order_by(Article.created_at.desc())
        .limit(limit)
    ).all()


def _valid_email(addr: str) -> bool:
    return bool(_EMAIL_RE.match((addr or "").strip()))


def _safe_tz_name(name: str) -> str:
    """Validate an IANA timezone name, falling back to UTC."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    name = (name or "").strip() or "UTC"
    try:
        ZoneInfo(name)
        return name
    except (ZoneInfoNotFoundError, ValueError, Exception):  # noqa: BLE001
        return "UTC"


def _esc(text: str) -> str:
    return html_lib.escape(str(text or ""))


def _shell(subtitle: str, body_html: str, *, unsubscribe_url: str = "") -> str:
    """Email-client-safe HTML shell (table layout, inline styles)."""
    unsub = ""
    if unsubscribe_url:
        unsub = (
            '<div style="margin-top:12px;">'
            f'<a href="{_esc(unsubscribe_url)}" '
            'style="display:inline-block;padding:8px 18px;border:1px solid #3a4a68;'
            "border-radius:8px;color:#93a1b8;text-decoration:none;font-size:12px;"
            'font-weight:600;background:#1b2740;">Unsubscribe</a></div>'
        )
    return f"""\
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:{_C_BG};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_C_BG};padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr><td style="background:linear-gradient(135deg,{_C_ACCENT},{_C_ACCENT2});border-radius:16px 16px 0 0;padding:24px 28px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#fff;">✍️ ContentPilot</div>
            <div style="opacity:.92;font-size:14px;margin-top:3px;color:#fff;">{_esc(subtitle)}</div>
          </td></tr>
          <tr><td style="background:{_C_CARD};border:1px solid {_C_BORDER};border-top:none;border-radius:0 0 16px 16px;padding:26px 28px;color:{_C_TEXT};">
            {body_html}
          </td></tr>
          <tr><td style="text-align:center;color:{_C_MUTED};font-size:12px;padding:18px 12px 4px;">
            You’re receiving this because you subscribed to ContentPilot emails.<br/>
            <span style="color:#6b7890;">Sent by ContentPilot · your AI writing companion</span>
            {unsub}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>"""


def _section(title: str) -> str:
    return (
        f'<div style="font-size:12px;color:{_C_MUTED};text-transform:uppercase;'
        f'letter-spacing:.08em;font-weight:700;margin:26px 0 12px;">{_esc(title)}</div>'
    )


def _stat_pill(value: str, label: str, accent: bool = False) -> str:
    bg = (
        f"linear-gradient(135deg,{_C_ACCENT},{_C_ACCENT2})"
        if accent
        else _C_CARD2
    )
    vcolor = "#ffffff"
    lcolor = "rgba(255,255,255,.85)" if accent else _C_MUTED
    border = "none" if accent else f"1px solid {_C_BORDER}"
    return (
        f'<td width="50%" style="padding:5px;">'
        f'<div style="background:{bg};border:{border};border-radius:12px;padding:16px;text-align:center;">'
        f'<div style="font-size:26px;font-weight:800;color:{vcolor};line-height:1.1;">{_esc(value)}</div>'
        f'<div style="font-size:12px;color:{lcolor};margin-top:3px;">{_esc(label)}</div>'
        f"</div></td>"
    )


def _hero(stats: StatsResponse) -> str:
    # Four DISTINCT metrics so cards never duplicate (this-week totals can equal
    # lifetime totals for a new library, so totals live in the summary prose).
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border-collapse:separate;"><tr>'
        + _stat_pill(f"{stats.articles_this_week}", "articles this week", accent=True)
        + _stat_pill(f"{stats.words_this_week:,}", "words this week", accent=True)
        + "</tr><tr>"
        + _stat_pill(f"{stats.avg_words:,}", "avg words / article")
        + _stat_pill(f"{stats.longest_words:,}", "longest article")
        + "</tr></table>"
    )


def _recent_list(recent: list[Article]) -> str:
    if not recent:
        return ""
    rows = ""
    for a in recent:
        title = _esc(a.title or a.topic or "(untitled)")
        created = a.created_at
        try:
            date_str = created.strftime("%b %d")
        except Exception:  # noqa: BLE001
            date_str = ""
        words = int(a.word_count or 0)
        rows += (
            f'<tr><td style="padding:10px 12px;border:1px solid {_C_BORDER};'
            f'border-radius:10px;background:{_C_CARD2};">'
            f'<div style="font-size:15px;font-weight:600;color:{_C_TEXT};">{title}</div>'
            f'<div style="font-size:12px;color:{_C_MUTED};margin-top:3px;">'
            f'{words:,} words · {date_str}</div>'
            f"</td></tr>"
            f'<tr><td style="height:8px;line-height:8px;">&nbsp;</td></tr>'
        )
    return _section("Recent articles") + (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>'
    )


def _mini_bars(stats: StatsResponse) -> str:
    pts = (stats.over_time or [])[-14:]
    if not pts or not any(p.count for p in pts):
        return ""
    max_c = max([p.count for p in pts] + [1])
    cells = ""
    for p in pts:
        h = 0 if p.count == 0 else max(6, round((p.count / max_c) * 48))
        color = _C_ACCENT if p.count else _C_BORDER
        min_h = h if h else 3
        cells += (
            f'<td valign="bottom" align="center" style="padding:0 2px;">'
            f'<div style="width:16px;height:{min_h}px;background:{color};'
            f'border-radius:3px 3px 2px 2px;"></div>'
            f"</td>"
        )
    first = _esc(pts[0].label)
    last = _esc(pts[-1].label)
    return (
        _section("Activity · last 14 days")
        + f'<table role="presentation" cellpadding="0" cellspacing="0" style="height:54px;"><tr>{cells}</tr></table>'
        + f'<div style="font-size:11px;color:{_C_MUTED};margin-top:6px;">{first} → {last}</div>'
    )


def _chips(items, limit: int) -> str:
    return "".join(
        f'<span style="display:inline-block;background:rgba(99,102,241,.15);'
        f'color:#c7ccff;border-radius:999px;padding:5px 11px;margin:0 6px 8px 0;'
        f'font-size:13px;">{_esc(it.name)}<span style="color:{_C_MUTED};"> · {it.count}</span></span>'
        for it in items[:limit]
    )


def _content_mix(stats: StatsResponse) -> str:
    parts = ""
    if stats.tones:
        parts += (
            f'<div style="font-size:13px;color:{_C_TEXT};margin:0 0 6px;font-weight:600;">Tones</div>'
            f'<div style="margin-bottom:12px;">{_chips(stats.tones, 6)}</div>'
        )
    if stats.audiences:
        parts += (
            f'<div style="font-size:13px;color:{_C_TEXT};margin:0 0 6px;font-weight:600;">Audiences</div>'
            f'<div>{_chips(stats.audiences, 6)}</div>'
        )
    if not parts:
        return ""
    return _section("Your content mix") + parts


def _keywords(stats: StatsResponse) -> str:
    if not stats.top_keywords:
        return ""
    return _section("Top keywords") + f"<div>{_chips(stats.top_keywords, 10)}</div>"


def _cta(app_url: str) -> str:
    if not app_url:
        return ""
    href = f"{app_url}/dashboard"
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">'
        f'<tr><td align="center">'
        f'<a href="{_esc(href)}" style="display:inline-block;background:linear-gradient(135deg,'
        f'{_C_ACCENT},{_C_ACCENT2});color:#fff;text-decoration:none;font-weight:700;'
        f'font-size:15px;padding:13px 28px;border-radius:12px;">Open your dashboard →</a>'
        f"</td></tr></table>"
    )


def build_digest(
    stats: StatsResponse,
    *,
    name: str = "",
    recent: list[Article] | None = None,
    app_url: str = "",
    unsubscribe_url: str = "",
) -> tuple[str, str]:
    """Return (subject, html) for the weekly digest."""
    greeting = f"Hi {_esc(name)}," if name else "Hi there,"

    # Human date range for the header subtitle: "Jul 06 · week in review".
    today = datetime.now(timezone.utc).strftime("%b %d, %Y")
    subject = f"📊 Your ContentPilot weekly digest — {today}"

    if stats.total_articles == 0:
        body = (
            f'<p style="margin:0 0 12px;font-size:16px;">{greeting}</p>'
            f'<p style="margin:0;color:{_C_MUTED};line-height:1.5;">You haven’t created any '
            "articles yet. Generate your first one and next week’s digest will be full of "
            "insights — word counts, activity trends, top keywords and more.</p>"
            + _cta(app_url)
        )
        return subject, _shell("Weekly digest", body, unsubscribe_url=unsubscribe_url)

    intro = (
        f'<p style="margin:0 0 4px;font-size:17px;font-weight:600;">{greeting}</p>'
        f'<p style="margin:0 0 20px;color:{_C_MUTED};font-size:14px;line-height:1.5;">'
        "Here’s a snapshot of your writing this week and where your library stands overall.</p>"
    )

    summary_line = (
        f'<p style="margin:18px 0 0;color:{_C_MUTED};font-size:14px;line-height:1.6;">'
        f'Your library now holds <b style="color:{_C_TEXT};">{stats.total_articles}</b> '
        f'article(s) totaling <b style="color:{_C_TEXT};">{stats.total_words:,}</b> words — '
        f'you’ve been active on <b style="color:{_C_TEXT};">{stats.active_days}</b> distinct day(s).</p>'
    )

    body = (
        intro
        + _hero(stats)
        + summary_line
        + _recent_list(recent or [])
        + _mini_bars(stats)
        + _content_mix(stats)
        + _keywords(stats)
        + _cta(app_url)
    )
    return subject, _shell("Weekly digest", body, unsubscribe_url=unsubscribe_url)


def build_test(*, name: str = "", app_url: str = "") -> tuple[str, str]:
    greeting = f"Hi {_esc(name)}," if name else "Hi there,"
    body = (
        f'<p style="margin:0 0 12px;font-size:16px;">{greeting}</p>'
        f'<p style="margin:0 0 8px;line-height:1.5;">🎉 Your ContentPilot email setup works! '
        "You’ll receive weekly digests and notifications at this address.</p>"
        f'<p style="margin:0;color:{_C_MUTED};font-size:14px;">You can turn these off anytime '
        "from your dashboard.</p>" + _cta(app_url)
    )
    return "✅ ContentPilot email test", _shell("Test email", body)


@router.get("/status", response_model=NotifyStatusResponse)
def notify_status(
    _user_id: str = Depends(get_current_user_id),
) -> NotifyStatusResponse:
    m = _mailer()
    return NotifyStatusResponse(
        configured=m.configured, from_address=m.from_address if m.configured else ""
    )


def _deliver(
    subject: str, body_html: str, req: NotifyRequest, mailer: Mailer
) -> NotifyResult:
    """Send when configured and not previewing; otherwise return the preview."""
    if req.preview or not mailer.configured:
        message = (
            "Preview only — server email isn’t configured yet."
            if not mailer.configured
            else "Preview generated."
        )
        return NotifyResult(
            sent=False, preview=True, message=message, subject=subject, html=body_html
        )
    try:
        mailer.send(to=req.email.strip(), subject=subject, html=body_html)
    except Exception as exc:  # noqa: BLE001 - surface SMTP errors to the client
        raise HTTPException(status_code=502, detail=f"Email send failed: {exc}") from exc
    return NotifyResult(
        sent=True, preview=False, message=f"Sent to {req.email.strip()}.", subject=subject
    )


@router.post("/digest", response_model=NotifyResult)
def send_digest(
    req: NotifyRequest,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> NotifyResult:
    if not _valid_email(req.email):
        raise HTTPException(status_code=422, detail="A valid email address is required.")
    stats = get_stats(user_id=user_id, session=session)
    recent = _recent_articles(session, user_id)
    # Include the user's own unsubscribe link if they're already subscribed.
    sub = session.exec(
        select(DigestSubscription).where(DigestSubscription.user_id == user_id)
    ).first()
    unsub = _unsub_url(sub.unsubscribe_token) if sub else ""
    subject, body_html = build_digest(
        stats,
        name=req.name.strip(),
        recent=recent,
        app_url=_app_url(),
        unsubscribe_url=unsub,
    )
    return _deliver(subject, body_html, req, _mailer())


@router.post("/test", response_model=NotifyResult)
def send_test(
    req: NotifyRequest,
    _user_id: str = Depends(get_current_user_id),
) -> NotifyResult:
    if not _valid_email(req.email):
        raise HTTPException(status_code=422, detail="A valid email address is required.")
    subject, body_html = build_test(name=req.name.strip(), app_url=_app_url())
    return _deliver(subject, body_html, req, _mailer())


# ---------------------------------------------------------------------------
# Subscription management (recurring weekly digest)
# ---------------------------------------------------------------------------


def _to_sub_response(sub: DigestSubscription | None) -> SubscriptionResponse:
    configured = _mailer().configured
    if not sub:
        return SubscriptionResponse(enabled=False, email_configured=configured)
    return SubscriptionResponse(
        enabled=sub.enabled,
        email=sub.email,
        frequency=sub.frequency,
        send_day=sub.send_day,
        send_hour=sub.send_hour,
        timezone=sub.timezone,
        last_sent_at=sub.last_sent_at.isoformat() if sub.last_sent_at else None,
        email_configured=configured,
    )


@router.get("/subscription", response_model=SubscriptionResponse)
def get_subscription(
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> SubscriptionResponse:
    sub = session.exec(
        select(DigestSubscription).where(DigestSubscription.user_id == user_id)
    ).first()
    return _to_sub_response(sub)


@router.put("/subscription", response_model=SubscriptionResponse)
def upsert_subscription(
    req: SubscriptionRequest,
    user_id: str = Depends(get_current_user_id),
    session: Session = Depends(get_session),
) -> SubscriptionResponse:
    if not _valid_email(req.email):
        raise HTTPException(status_code=422, detail="A valid email address is required.")
    sub = session.exec(
        select(DigestSubscription).where(DigestSubscription.user_id == user_id)
    ).first()
    now = datetime.now(timezone.utc)
    send_day = max(0, min(6, int(req.send_day)))
    send_hour = max(0, min(23, int(req.send_hour)))
    tz = _safe_tz_name(req.timezone)
    if sub:
        sub.email = req.email.strip()
        sub.name = req.name.strip()
        sub.enabled = req.enabled
        sub.frequency = req.frequency or "weekly"
        sub.send_day = send_day
        sub.send_hour = send_hour
        sub.timezone = tz
        sub.updated_at = now
    else:
        sub = DigestSubscription(
            user_id=user_id,
            email=req.email.strip(),
            name=req.name.strip(),
            enabled=req.enabled,
            frequency=req.frequency or "weekly",
            send_day=send_day,
            send_hour=send_hour,
            timezone=tz,
        )
    session.add(sub)
    session.commit()
    session.refresh(sub)
    return _to_sub_response(sub)


def _unsub_page(title: str, message: str) -> str:
    return f"""\
<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{_esc(title)}</title></head>
<body style="margin:0;background:{_C_BG};font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;
color:{_C_TEXT};display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:440px;padding:32px;text-align:center;background:{_C_CARD};
  border:1px solid {_C_BORDER};border-radius:16px;">
    <div style="font-size:40px;">📭</div>
    <h1 style="font-size:20px;margin:12px 0 8px;">{_esc(title)}</h1>
    <p style="color:{_C_MUTED};line-height:1.5;margin:0;">{_esc(message)}</p>
  </div>
</body></html>"""


@router.get("/unsubscribe", response_class=HTMLResponse)
def unsubscribe(token: str, session: Session = Depends(get_session)) -> HTMLResponse:
    """Public one-click unsubscribe — no auth, identified by the token."""
    sub = None
    if token:
        sub = session.exec(
            select(DigestSubscription).where(
                DigestSubscription.unsubscribe_token == token
            )
        ).first()
    if not sub:
        return HTMLResponse(
            _unsub_page(
                "Link expired",
                "We couldn’t find that subscription. It may have already been removed.",
            ),
            status_code=404,
        )
    if sub.enabled:
        sub.enabled = False
        sub.updated_at = datetime.now(timezone.utc)
        session.add(sub)
        session.commit()
    return HTMLResponse(
        _unsub_page(
            "You’re unsubscribed",
            "You won’t receive the weekly ContentPilot digest anymore. "
            "You can re-enable it anytime from your dashboard.",
        )
    )


# ---------------------------------------------------------------------------
# Scheduled job — called by APScheduler (see app.main lifespan)
# ---------------------------------------------------------------------------


def deliver_digests(*, respect_schedule: bool = True, dry_run: bool = False) -> dict:
    """Send the digest to due subscribers.

    Runs outside a request, so it opens its own DB session. Meant to be invoked
    hourly: for each enabled subscriber, "now" is converted to their timezone
    and they're emailed only when the local weekday + hour match their choice.
    A per-subscriber local-date guard prevents double-sends. `respect_schedule`
    can be turned off to send to everyone (used for tests). `dry_run` builds but
    never sends. Returns a summary for logging.
    """
    from zoneinfo import ZoneInfo

    from ..db import engine  # local import avoids a cycle at module load

    settings = get_settings()
    mailer = Mailer(settings)
    if not mailer.configured and not dry_run:
        return {"sent": 0, "failed": 0, "skipped": 0, "reason": "email-not-configured"}

    app_url = _app_url()
    now_utc = datetime.now(timezone.utc)
    sent = failed = skipped = 0
    with Session(engine) as session:
        subs = session.exec(
            select(DigestSubscription).where(DigestSubscription.enabled == True)  # noqa: E712
        ).all()
        for sub in subs:
            if respect_schedule:
                try:
                    tz = ZoneInfo(sub.timezone or "UTC")
                except Exception:  # noqa: BLE001
                    tz = timezone.utc
                local = now_utc.astimezone(tz)
                # On the subscriber's chosen weekday, deliver at OR AFTER their chosen
                # hour (not only exactly at it). This way a server that was down or
                # reloading at the exact hour still catches up later the SAME day; the
                # per-day dedupe below stops repeat sends.
                if local.weekday() != int(sub.send_day):
                    skipped += 1
                    continue
                if local.hour < int(sub.send_hour):
                    skipped += 1
                    continue
                # Never send twice on the same local day.
                if sub.last_sent_at is not None:
                    last = sub.last_sent_at
                    if last.tzinfo is None:
                        last = last.replace(tzinfo=timezone.utc)
                    if last.astimezone(tz).date() == local.date():
                        skipped += 1
                        continue
            try:
                stats = get_stats(user_id=sub.user_id, session=session)
                recent = _recent_articles(session, sub.user_id)
                subject, html = build_digest(
                    stats,
                    name=sub.name,
                    recent=recent,
                    app_url=app_url,
                    unsubscribe_url=_unsub_url(sub.unsubscribe_token),
                )
                if not dry_run:
                    mailer.send(to=sub.email, subject=subject, html=html)
                    sub.last_sent_at = datetime.now(timezone.utc)
                    session.add(sub)
                sent += 1
            except Exception:  # noqa: BLE001 - one bad recipient shouldn't stop the batch
                failed += 1
        if not dry_run:
            session.commit()
    return {
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
        "subscribers": len(subs),
        "dry_run": dry_run,
    }
