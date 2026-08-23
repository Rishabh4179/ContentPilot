"""Supabase Storage for generated images (REST API, stdlib only).

Images are uploaded to a Supabase Storage bucket and served from its public URL,
so they survive redeploys and work on serverless hosts (Vercel) whose filesystem
is ephemeral and read-only. Uses the Storage REST API with the service-role key.
"""
from __future__ import annotations

import re
import urllib.error
import urllib.request
import uuid

from ..config import Settings


class SupabaseStorage:
    def __init__(self, settings: Settings) -> None:
        self._base = (settings.supabase_url or "").strip().rstrip("/")
        self._key = (settings.supabase_service_key or "").strip()
        self._bucket = (settings.supabase_bucket or "").strip()

    @property
    def configured(self) -> bool:
        """True when enough Supabase settings exist to upload + build public URLs."""
        return bool(self._base and self._key and self._bucket)

    @staticmethod
    def slugify(text: str, max_len: int = 50) -> str:
        s = (text or "").lower().strip()
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        return s[:max_len].strip("-") or "image"

    @staticmethod
    def _ext_for(mime: str) -> str:
        m = (mime or "").lower()
        if "png" in m:
            return "png"
        if "webp" in m:
            return "webp"
        if "gif" in m:
            return "gif"
        return "jpg"

    def _public_url(self, object_key: str) -> str:
        return f"{self._base}/storage/v1/object/public/{self._bucket}/{object_key}"

    def upload(
        self,
        data: bytes,
        mime: str,
        *,
        key: str | None = None,
        name_hint: str | None = None,
    ) -> str:
        """Upload image bytes and return the public URL. Raises if not configured."""
        if not self.configured:
            raise RuntimeError(
                "Supabase Storage is not configured. Set SUPABASE_URL, "
                "SUPABASE_SERVICE_KEY and SUPABASE_BUCKET in the backend .env."
            )
        if key:
            object_key = key
        elif name_hint:
            slug = self.slugify(name_hint)
            short_id = uuid.uuid4().hex[:8]
            ext = self._ext_for(mime)
            object_key = f"images/{slug}-{short_id}.{ext}"
        else:
            object_key = f"images/{uuid.uuid4().hex}.{self._ext_for(mime)}"
        url = f"{self._base}/storage/v1/object/{self._bucket}/{object_key}"
        request = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._key}",
                "apikey": self._key,
                "Content-Type": mime or "image/jpeg",
                "Cache-Control": "public, max-age=31536000, immutable",
                # Overwrite if the key already exists (idempotent re-migrations).
                "x-upsert": "true",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "ignore")[:300]
            err = RuntimeError(f"Supabase upload failed ({exc.code}): {body}")
            err.status_code = exc.code
            raise err from exc
        return self._public_url(object_key)
