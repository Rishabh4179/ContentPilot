"""Clerk authentication — verify session JWTs and resolve the current user.

Auth is optional: if no Clerk keys are configured the API runs in single-user
mode and every request is attributed to the "local" user. As soon as a
publishable key (or issuer/JWKS override) is set, bearer tokens are required
and verified against Clerk's JWKS.
"""
import base64

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

from .config import get_settings

_settings = get_settings()


def _decode_domain(key: str) -> str | None:
    """Clerk publishable keys base64-encode '<frontend-api-domain>$'."""
    for prefix in ("pk_test_", "pk_live_"):
        if key.startswith(prefix):
            encoded = key[len(prefix):]
            padding = "=" * (-len(encoded) % 4)
            try:
                decoded = base64.b64decode(encoded + padding).decode()
            except Exception:  # noqa: BLE001
                return None
            return decoded.rstrip("$").rstrip("/") or None
    return None


def _pk() -> str:
    return _settings.clerk_publishable_key or _settings.vite_clerk_publishable_key


def _issuer() -> str | None:
    if _settings.clerk_issuer:
        return _settings.clerk_issuer.rstrip("/")
    domain = _decode_domain(_pk())
    return f"https://{domain}" if domain else None


CLERK_ENABLED = bool(
    _pk() or _settings.clerk_issuer or _settings.clerk_jwks_url
)

_ISSUER = _issuer()
_JWKS_URL = _settings.clerk_jwks_url or (
    f"{_ISSUER}/.well-known/jwks.json" if _ISSUER else None
)
_jwks_client = PyJWKClient(_JWKS_URL) if _JWKS_URL else None


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    """FastAPI dependency: the Clerk user id, or 'local' when auth is disabled."""
    if not CLERK_ENABLED:
        return "local"
    if not _jwks_client:
        raise HTTPException(status_code=500, detail="Clerk is misconfigured (no JWKS URL)")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.split(" ", 1)[1].strip()
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=_ISSUER,
            options={"verify_aud": False},
            leeway=10,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Session missing user id")
    return user_id
