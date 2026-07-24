"""
Nahraje public/data/* do Cloudflare R2 (S3 API) — rychlé doručení bez git CDN cache.

Potřebné env (GitHub Secrets nebo lokálně):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
Volitelně: R2_PUBLIC_URL (jen informativní log)

CLI:
  --exclude data/satellite/   (lze opakovat) — neuploaduj prefix
  --only data/satellite/      (lze opakovat) — upload jen tyto prefixy
  --files data/opera/latest.png  (lze opakovat) — konkrétní soubory
  --files a --only se sčítají (OR); --exclude platí vždy
"""

from __future__ import annotations

import argparse
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


def _norm_prefix(p: str) -> str:
    return p.replace("\\", "/").lstrip("/")


def _norm_file_rel(p: str) -> str:
    """public/data/... nebo data/... → data/..."""
    n = _norm_prefix(p)
    if n.startswith("public/"):
        n = n[len("public/") :]
    return n


def _matches_prefix(rel: str, pref: str) -> bool:
    n = _norm_prefix(pref)
    if n.endswith("/"):
        return rel.startswith(n)
    return rel == n or rel.startswith(n + "/")


def _should_upload(
    rel: str,
    *,
    only: list[str] | None = None,
    exclude: list[str] | None = None,
    files: set[str] | None = None,
) -> bool:
    if not rel.startswith("data/"):
        return False
    if any(rel.startswith(p) for p in SKIP_PREFIXES):
        return False
    if exclude and any(_matches_prefix(rel, p) for p in exclude):
        return False
    if files or only:
        in_files = bool(files and rel in files)
        in_only = bool(only and any(_matches_prefix(rel, p) for p in only))
        return in_files or in_only
    return True


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


def upload_tree(
    *,
    only: list[str] | None = None,
    exclude: list[str] | None = None,
    files: list[str] | None = None,
) -> int:
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET", "").strip()

    file_set = {_norm_file_rel(f) for f in (files or []) if f.strip()} or None

    if not all((account, access, secret, bucket)):
        print("R2: credentials missing — skip upload (set GitHub Secrets)", flush=True)
        # Explicit --only/--exclude/--files běhy musí failnout, ne tiše uspět
        if only or exclude or file_set:
            return 1
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
    skipped = 0
    missing = 0

    # Explicit --files: upload i když nejsou v rglob (fail soft s logem)
    if file_set:
        for rel in sorted(file_set):
            path = PUBLIC / rel
            if not path.is_file():
                print(f"R2: missing file {rel}", file=sys.stderr, flush=True)
                missing += 1
                continue
            if not _should_upload(
                rel, only=only, exclude=exclude, files=file_set
            ):
                skipped += 1
                continue
            client.upload_file(
                str(path),
                bucket,
                rel,
                ExtraArgs={
                    "ContentType": _mime(path),
                    "CacheControl": CACHE_CONTROL,
                },
            )
            uploaded += 1

    for path in sorted(PUBLIC.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(PUBLIC).as_posix()
        # Už nahráno přes --files
        if file_set and rel in file_set:
            continue
        if not _should_upload(rel, only=only, exclude=exclude, files=file_set):
            skipped += 1
            continue
        client.upload_file(
            str(path),
            bucket,
            rel,
            ExtraArgs={
                "ContentType": _mime(path),
                "CacheControl": CACHE_CONTROL,
            },
        )
        uploaded += 1

    public_url = os.environ.get("R2_PUBLIC_URL", "").strip()
    filt = []
    if only:
        filt.append(f"only={only}")
    if exclude:
        filt.append(f"exclude={exclude}")
    if file_set:
        filt.append(f"files={len(file_set)}")
    extra = f" ({', '.join(filt)})" if filt else ""
    print(
        f"R2: uploaded {uploaded} file(s) to s3://{bucket}/{extra} "
        f"(skipped {skipped}, missing {missing})",
        flush=True,
    )
    if public_url:
        print(f"R2: public base {public_url.rstrip('/')}/", flush=True)
    # Explicit --files: chybějící cesty = fail (fast-path nesmí tiše uspět)
    if file_set and missing:
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload public/data to Cloudflare R2")
    ap.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Skip this prefix (repeatable), e.g. data/satellite/",
    )
    ap.add_argument(
        "--only",
        action="append",
        default=[],
        help="Upload only this prefix (repeatable)",
    )
    ap.add_argument(
        "--files",
        action="append",
        default=[],
        help="Upload specific file(s) under public/ (repeatable), e.g. data/opera/latest.png",
    )
    args = ap.parse_args()
    # Allow space-separated paths in a single --files "a b c"
    files: list[str] = []
    for entry in args.files or []:
        files.extend(p for p in entry.split() if p.strip())
    return upload_tree(
        only=args.only or None,
        exclude=args.exclude or None,
        files=files or None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
