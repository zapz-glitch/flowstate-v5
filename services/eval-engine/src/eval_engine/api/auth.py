"""Service-to-service credential records for the V4 durable API.

One baseline token env exists (``V4_INTERNAL_API_TOKEN``); this module
defines the secure multi-credential record format used to derive
tenant/user from the credential itself:

``V4_API_CREDENTIALS``: JSON array of credential records. Each record:

- ``tenant_id`` (required): tenant the credential authorizes.
- ``user_id`` (required): service user the credential authorizes.
- ``token_sha256`` (required): hex SHA-256 of the bearer token. Only the
  hash is stored in configuration; the plaintext token never appears here.
- ``expires_at`` (optional, ISO-8601): when set, the credential is
  rejected at or after this instant.
- ``previous_token_sha256`` (optional): hash of the immediately previous
  token accepted during rotation.
- ``previous_expires_at`` (optional, ISO-8601): explicit expiry for the
  previous token. Rotation support requires both previous fields; the
  previous token is rejected once expired or absent.

Verification uses ``hmac.compare_digest`` (constant time) and never logs
tokens or hashes at any level.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class Credential:
    tenant_id: str
    user_id: str
    token_sha256: str
    expires_at: datetime | None = None
    previous_token_sha256: str | None = None
    previous_expires_at: datetime | None = None


def sha256_hex(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _parse_instant(value: object, field: str) -> datetime | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str):
        raise ValueError(f"credential {field} must be an ISO-8601 string")
    text = value.strip()
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _valid_hex64(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


def parse_credentials(raw: str | None) -> list[Credential]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("V4_API_CREDENTIALS must be a JSON array") from exc
    if not isinstance(payload, list) or not payload:
        raise ValueError("V4_API_CREDENTIALS must be a non-empty JSON array")
    records: list[Credential] = []
    seen_hashes: set[str] = set()
    for entry in payload:
        if not isinstance(entry, dict):
            raise ValueError("each credential record must be an object")
        tenant = str(entry.get("tenant_id", "")).strip()
        user = str(entry.get("user_id", "")).strip()
        token_hash = str(entry.get("token_sha256", "")).strip().lower()
        if not tenant or not user:
            raise ValueError("credential tenant_id and user_id are required")
        if not _valid_hex64(token_hash):
            raise ValueError("credential token_sha256 must be 64 hex chars")
        if token_hash in seen_hashes:
            raise ValueError("duplicate credential token hash")
        seen_hashes.add(token_hash)
        previous = entry.get("previous_token_sha256")
        previous_hash: str | None = None
        if previous is not None and str(previous).strip():
            previous_hash = str(previous).strip().lower()
            if not _valid_hex64(previous_hash):
                raise ValueError("credential previous_token_sha256 must be 64 hex chars")
            if previous_hash == token_hash:
                raise ValueError("previous token must differ from current token")
            if previous_hash in seen_hashes:
                raise ValueError("duplicate credential token hash")
            seen_hashes.add(previous_hash)
        previous_expiry = _parse_instant(entry.get("previous_expires_at"), "previous_expires_at")
        if previous_hash is not None and previous_expiry is None:
            raise ValueError("rotation requires previous_expires_at")
        if previous_hash is None and entry.get("previous_expires_at") not in (None, ""):
            raise ValueError("previous_expires_at requires previous_token_sha256")
        records.append(
            Credential(
                tenant_id=tenant,
                user_id=user,
                token_sha256=token_hash,
                expires_at=_parse_instant(entry.get("expires_at"), "expires_at"),
                previous_token_sha256=previous_hash,
                previous_expires_at=previous_expiry,
            )
        )
    return records


def load_credentials(env: dict[str, str] | None = None) -> list[Credential]:
    source = env if env is not None else os.environ
    raw = source.get("V4_API_CREDENTIALS", "")
    records = parse_credentials(raw)
    if records:
        return records
    legacy = (source.get("V4_INTERNAL_API_TOKEN", "") or "").strip()
    if not legacy:
        return []
    return [
        Credential(
            tenant_id=(source.get("V4_DEFAULT_TENANT", "") or "").strip() or "default",
            user_id=(source.get("V4_DEFAULT_USER", "") or "").strip() or "service",
            token_sha256=sha256_hex(legacy),
        )
    ]


def _expired(instant: datetime | None, now: datetime) -> bool:
    return instant is not None and now >= instant


def match_credential(
    candidates: list[Credential], presented: str, *, now: datetime | None = None
) -> Credential | None:
    if not presented:
        return None
    current = now or datetime.now(timezone.utc)
    presented_hash = sha256_hex(presented)
    for record in candidates:
        if _expired(record.expires_at, current):
            continue
        if hmac.compare_digest(presented_hash, record.token_sha256):
            return record
        if (
            record.previous_token_sha256 is not None
            and not _expired(record.previous_expires_at, current)
            and hmac.compare_digest(presented_hash, record.previous_token_sha256)
        ):
            return record
    return None


__all__ = [
    "Credential",
    "load_credentials",
    "match_credential",
    "parse_credentials",
    "sha256_hex",
]
