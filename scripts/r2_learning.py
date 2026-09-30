"""Synchronizuje public/data/learning s R2 (learning žije v R2, ne v gitu).

Důvod: learning events/samples jsou ~100 MB JSONL na měsíc a appendují se každý
běh → v gitu bobtnaly repo o GB. V R2 jsou navíc gzipované (~10× menší přenos),
takže i rychlý Live radar zvládne pull+push bez citelného zdržení.

Env (GitHub Secrets): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

CLI:
  pull [--month YYYY-MM]   stáhne learning z R2 (bez --month vše)
  push [--month YYYY-MM]   nahraje learning do R2 (gzip)
  - lokálně zůstávají .jsonl (skripty se nemění), v R2 jsou .jsonl.gz
  - --month omezí na daný měsíc (+ state.json); pull nikdy nemaže lokální soubory
"""

from __future__ import annotations

import argparse
import gzip
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEARNING = ROOT / "public" / "data" / "learning"
PREFIX = "data/learning/"
ALWAYS = {"state.json"}  # potřebné napříč měsíci
CONTENT_TYPE = "application/gzip"


def _client():
    try:
        import boto3
    except ImportError:
        print("r2_learning: boto3 not installed", file=sys.stderr, flush=True)
        return None, None
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET", "").strip()
    if not all((account, access, secret, bucket)):
        print("r2_learning: R2 credentials missing", file=sys.stderr, flush=True)
        return None, None
    import boto3

    try:
        from botocore.config import Config as BotoConfig

        config = BotoConfig(
            connect_timeout=15, read_timeout=120, retries={"max_attempts": 2}
        )
    except Exception:  # pragma: no cover
        config = None

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
        **({"config": config} if config is not None else {}),
    )
    return s3, bucket


def _wanted(name: str, month: str | None) -> bool:
    if not month:
        return True
    if name in ALWAYS:
        return True
    return name.endswith(f"-{month}.jsonl")


def _list_keys(s3, bucket: str) -> list[str]:
    keys: list[str] = []
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": PREFIX}
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        keys += [o["Key"] for o in resp.get("Contents", [])]
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return keys


def pull(month: str | None) -> int:
    s3, bucket = _client()
    if not s3:
        return 1
    LEARNING.mkdir(parents=True, exist_ok=True)
    n = 0
    for key in _list_keys(s3, bucket):
        rel = key[len(PREFIX):]
        if not rel or not rel.endswith(".gz"):
            continue
        name = rel[:-3]  # strip .gz
        if not _wanted(name, month):
            continue
        with tempfile.NamedTemporaryFile(delete=False, suffix=".gz") as tmp:
            tmp_path = tmp.name
        s3.download_file(bucket, key, tmp_path)
        dest = LEARNING / name
        with gzip.open(tmp_path, "rb") as src, open(dest, "wb") as out:
            shutil.copyfileobj(src, out)
        os.unlink(tmp_path)
        print(f"r2_learning: pulled {name}", flush=True)
        n += 1
    print(f"r2_learning: pull done ({n} souborů)", flush=True)
    return 0


def push(month: str | None) -> int:
    s3, bucket = _client()
    if not s3:
        return 1
    if not LEARNING.is_dir():
        print("r2_learning: learning dir missing — nothing to push", flush=True)
        return 0
    n = 0
    for path in sorted(LEARNING.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        if not _wanted(path.name, month):
            continue
        with tempfile.NamedTemporaryFile(delete=False, suffix=".gz") as tmp:
            tmp_path = tmp.name
        with open(path, "rb") as src, gzip.open(tmp_path, "wb", compresslevel=6) as out:
            shutil.copyfileobj(src, out)
        s3.upload_file(
            tmp_path,
            bucket,
            PREFIX + path.name + ".gz",
            ExtraArgs={"ContentType": CONTENT_TYPE, "CacheControl": "no-store"},
        )
        os.unlink(tmp_path)
        print(f"r2_learning: pushed {path.name}", flush=True)
        n += 1
    print(f"r2_learning: push done ({n} souborů)", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Sync learning with R2 (gzip)")
    ap.add_argument("action", choices=["pull", "push"])
    ap.add_argument("--month", default="", help="Jen tento měsíc (YYYY-MM) + state.json")
    args = ap.parse_args()
    month = args.month.strip() or None
    return pull(month) if args.action == "pull" else push(month)


if __name__ == "__main__":
    raise SystemExit(main())
