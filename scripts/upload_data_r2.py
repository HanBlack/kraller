"""
Nahraje public/data/* do Cloudflare R2 (S3 API) — rychlé doručení bez git CDN cache.

Potřebné env (GitHub Secrets nebo lokálně):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
Volitelně: R2_PUBLIC_URL (jen informativní log)
"""

from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

# Rychlá obnova — krátká cache na CDN, klient stejně cache-bustuje ?t=
CACHE_CONTROL = "public, max-age=45, must-revalidate"

# Veřejná data — prohlížeč z libovolné domény; * je nejspolehlivější u r2.dev.
DEFAULT_CORS_ORIGINS = ("*",)

SKIP_PREFIXES = (
    "data/learning/",  # learning zůstává v gitu (hodinový job)
)

CONTENT_TYPES = {
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".jsonl": "application/x-ndjson",
}


def _mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _should_upload(rel: str) -> bool:
    if not rel.startswith("data/"):
        return False
    return not any(rel.startswith(p) for p in SKIP_PREFIXES)


def _cors_origins() -> list[str]:
    raw = os.environ.get("R2_CORS_ORIGINS", "").strip()
    if raw:
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]
    return list(DEFAULT_CORS_ORIGINS)


def ensure_bucket_cors(client, bucket: str) -> bool:
    """Nastaví CORS na bucketu — bez toho prohlížeč z kraller.eu fetch neprojde."""
    origins = _cors_origins()
    try:
        client.put_bucket_cors(
            Bucket=bucket,
            CORSConfiguration={
                "CORSRules": [
                    {
                        "AllowedOrigins": origins,
                        "AllowedMethods": ["GET", "HEAD"],
                        "AllowedHeaders": ["*"],
                        "ExposeHeaders": ["ETag"],
                        "MaxAgeSeconds": 3600,
                    },
                ],
            },
        )
        print(f"R2: CORS applied for {origins}", flush=True)
        return True
    except Exception as exc:
        print(
            f"R2: CORS setup failed ({exc}) — nastav ručně v Cloudflare → R2 → bucket → CORS",
            file=sys.stderr,
            flush=True,
        )
        return False


def upload_tree() -> int:
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET", "").strip()

    if not all((account, access, secret, bucket)):
        print("R2: credentials missing — skip upload (set GitHub Secrets)", flush=True)
        return 0

    try:
        import boto3
    except ImportError:
        print("R2: boto3 not installed", file=sys.stderr, flush=True)
        return 1

    endpoint = f"https://{account}.r2.cloudflarestorage.com"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
    )

    if not PUBLIC.is_dir():
        print("R2: public/ missing", file=sys.stderr, flush=True)
        return 1

    ensure_bucket_cors(client, bucket)

    uploaded = 0
    for path in sorted(PUBLIC.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(PUBLIC).as_posix()
        if not _should_upload(rel):
            continue
        key = rel
        client.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={
                "ContentType": _mime(path),
                "CacheControl": CACHE_CONTROL,
            },
        )
        uploaded += 1

    public_url = os.environ.get("R2_PUBLIC_URL", "").strip()
    print(f"R2: uploaded {uploaded} file(s) to s3://{bucket}/", flush=True)
    if public_url:
        print(f"R2: public base {public_url.rstrip('/')}/", flush=True)
    return 0


def main() -> int:
    return upload_tree()


if __name__ == "__main__":
    raise SystemExit(main())
