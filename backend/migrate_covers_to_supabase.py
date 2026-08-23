"""One-off migration: move locally stored images to Supabase Storage.

Uploads every file in backend/covers/ to the Supabase bucket, then rewrites every
`/api/covers/<file>` reference in the DB (Article.cover_url AND inside
Article.markdown for inserted section images) to the new public Supabase URL.

Run from the backend/ dir with the .venv python AFTER filling in the SUPABASE_*
creds in backend/.env:

    cd backend
    .venv/Scripts/python.exe migrate_covers_to_supabase.py            # dry run
    .venv/Scripts/python.exe migrate_covers_to_supabase.py --apply    # do it
"""
from __future__ import annotations

import mimetypes
import sys
from pathlib import Path

from sqlmodel import Session, select

from app.config import get_settings
from app.db import engine
from app.models import Article
from app.services.storage import SupabaseStorage

COVERS_DIR = Path(__file__).resolve().parent / "covers"
LOCAL_PREFIX = "/api/covers/"


def _mime_for(path: Path) -> str:
    guess, _ = mimetypes.guess_type(str(path))
    if guess:
        return guess
    head = path.read_bytes()[:8]
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"


def main() -> None:
    apply = "--apply" in sys.argv
    settings = get_settings()
    storage = SupabaseStorage(settings)
    if not storage.configured:
        print("Supabase Storage is not configured. Fill SUPABASE_* in backend/.env first.")
        sys.exit(1)

    # 1) Upload each local file, keeping its original filename as the object key so
    #    the URL suffix stays stable and easy to map.
    url_map: dict[str, str] = {}  # "/api/covers/<file>" -> "https://.../images/<file>"
    files = sorted(COVERS_DIR.glob("*")) if COVERS_DIR.exists() else []
    files = [f for f in files if f.is_file()]
    print(f"Found {len(files)} local image(s) in {COVERS_DIR}")
    for f in files:
        key = f"images/{f.name}"
        old_ref = LOCAL_PREFIX + f.name
        if apply:
            data = f.read_bytes()
            new_url = storage.upload(data, _mime_for(f), key=key)
        else:
            new_url = f"{settings.supabase_url.rstrip('/')}/storage/v1/object/public/{settings.supabase_bucket}/{key}"
        url_map[old_ref] = new_url
        print(f"  {'uploaded' if apply else 'would upload'}: {old_ref} -> {new_url}")

    # 2) Rewrite DB references (cover_url + markdown section images).
    covers_changed = md_changed = 0
    with Session(engine) as s:
        arts = s.exec(select(Article)).all()
        for a in arts:
            touched = False
            if a.cover_url and a.cover_url.startswith(LOCAL_PREFIX):
                mapped = url_map.get(a.cover_url)
                if mapped:
                    a.cover_url = mapped
                    covers_changed += 1
                    touched = True
            if a.markdown and LOCAL_PREFIX in a.markdown:
                new_md = a.markdown
                for old_ref, new_url in url_map.items():
                    new_md = new_md.replace(old_ref, new_url)
                if new_md != a.markdown:
                    a.markdown = new_md
                    md_changed += 1
                    touched = True
            if touched and apply:
                s.add(a)
        if apply:
            s.commit()

    print(
        f"\n{'APPLIED' if apply else 'DRY RUN'}: "
        f"cover_url updates={covers_changed}, markdown updates={md_changed}"
    )
    if not apply:
        print("Re-run with --apply to perform the upload + DB rewrite.")


if __name__ == "__main__":
    main()
