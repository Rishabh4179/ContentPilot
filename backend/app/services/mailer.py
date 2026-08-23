"""Email delivery via Resend (HTTP API) with an SMTP fallback.

Resend is preferred because it sends over HTTPS (port 443), which is never blocked
by hosts — unlike raw SMTP ports (25/465/587), which many platforms (Render,
Vercel) block. Set RESEND_API_KEY + RESEND_FROM to use it. If Resend isn't
configured, it falls back to SMTP (smtplib), useful for local dev with Gmail.

Uses only the Python standard library (urllib + smtplib), no extra dependencies.

Email is optional: when neither transport is configured, `configured` is False and
callers can fall back to returning a rendered preview instead of sending.
"""
from __future__ import annotations

import json
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from ..config import Settings

_RESEND_ENDPOINT = "https://api.resend.com/emails"


class Mailer:
    def __init__(self, settings: Settings) -> None:
        self._host = (settings.smtp_host or "").strip()
        self._port = int(settings.smtp_port or 587)
        self._user = (settings.smtp_user or "").strip()
        self._password = settings.smtp_password or ""
        self._from_addr = (settings.smtp_from or settings.smtp_user or "").strip()
        self._from_name = settings.smtp_from_name or "ContentPilot"
        self._use_tls = bool(settings.smtp_use_tls)
        # Resend (preferred HTTP transport).
        self._resend_key = (settings.resend_api_key or "").strip()
        self._resend_from = (settings.resend_from or "").strip()
        if not self._resend_from and self._from_addr:
            # Reuse the SMTP identity when a dedicated Resend from isn't given.
            self._resend_from = formataddr((self._from_name, self._from_addr))

    @property
    def _resend_ready(self) -> bool:
        return bool(self._resend_key and self._resend_from)

    @property
    def _smtp_ready(self) -> bool:
        return bool(self._host and self._from_addr)

    @property
    def configured(self) -> bool:
        """True when at least one transport (Resend or SMTP) can send."""
        return self._resend_ready or self._smtp_ready

    @property
    def from_address(self) -> str:
        """The plain from email, for status display."""
        if self._from_addr:
            return self._from_addr
        # Parse the email out of a "Name <email>" Resend from.
        return parseaddr(self._resend_from)[1]

    def send(self, *, to: str, subject: str, html: str, text: str | None = None) -> None:
        """Send an email. Prefers Resend (HTTP), falls back to SMTP. Raises on failure."""
        if self._resend_ready:
            self._send_resend(to=to, subject=subject, html=html, text=text)
            return
        if self._smtp_ready:
            self._send_smtp(to=to, subject=subject, html=html, text=text)
            return
        raise RuntimeError(
            "Email is not configured. Set RESEND_API_KEY + RESEND_FROM (preferred) "
            "or SMTP_HOST/SMTP_USER/SMTP_PASSWORD in the backend .env."
        )

    def _send_resend(self, *, to: str, subject: str, html: str, text: str | None) -> None:
        payload: dict = {
            "from": self._resend_from,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if text:
            payload["text"] = text
        request = urllib.request.Request(
            _RESEND_ENDPOINT,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._resend_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "ignore")[:300]
            raise RuntimeError(f"Resend send failed ({exc.code}): {body}") from exc

    def _send_smtp(self, *, to: str, subject: str, html: str, text: str | None) -> None:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = formataddr((self._from_name, self._from_addr))
        msg["To"] = to
        msg.set_content(text or "This message requires an HTML-capable email client.")
        msg.add_alternative(html, subtype="html")

        context = ssl.create_default_context()
        if self._port == 465:
            # Implicit TLS.
            with smtplib.SMTP_SSL(self._host, self._port, context=context, timeout=20) as server:
                if self._user:
                    server.login(self._user, self._password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(self._host, self._port, timeout=20) as server:
                server.ehlo()
                if self._use_tls:
                    server.starttls(context=context)
                    server.ehlo()
                if self._user:
                    server.login(self._user, self._password)
                server.send_message(msg)

