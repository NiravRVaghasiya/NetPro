"""Identity policy: row ids, installation ids, access tokens, masking.

Frozen rules (`docs/python-migration/data-model.md`, `@netpro/db/identity.ts`):

- Rows use `crypto.randomUUID()` strings — lowercase, hyphenated UUID v4.
- Installation ids are `ins_` + 24 hex characters (12 random bytes).
- Access tokens are `np_` + base64url(32 random bytes), no padding.
- Nothing ever displays a credential in full: `mask_secret` yields the last
  four characters, matching `netpro token --show` and `GET /api/credentials`.
"""

from __future__ import annotations

import base64
import re
import secrets
import uuid

__all__ = [
    "ACCESS_TOKEN_PREFIX",
    "INSTALLATION_ID_PREFIX",
    "is_access_token",
    "is_row_id",
    "mask_secret",
    "new_access_token",
    "new_id",
    "new_installation_id",
]

#: Prefix on generated installation ids, so a stray id is self-describing.
INSTALLATION_ID_PREFIX = "ins_"

#: Prefix on generated access tokens.
ACCESS_TOKEN_PREFIX = "np_"

_ROW_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.ASCII,
)


def new_id() -> str:
    """A new row id: UUID v4 as a lowercase hyphenated string."""
    return str(uuid.uuid4())


def is_row_id(value: str) -> bool:
    """True when `value` has the shape of a NetPro row id."""
    return bool(_ROW_ID.match(value.strip().lower()))


def new_installation_id() -> str:
    """A new local installation id: `ins_` + 24 hex characters."""
    return f"{INSTALLATION_ID_PREFIX}{secrets.token_hex(12)}"


def new_access_token() -> str:
    """A new local access token: `np_` + 43 base64url characters (32 bytes)."""
    body = secrets.token_bytes(32)
    encoded = base64.urlsafe_b64encode(body).rstrip(b"=").decode("ascii")
    return f"{ACCESS_TOKEN_PREFIX}{encoded}"


def is_access_token(value: str) -> bool:
    """True when `value` looks like a NetPro access token (shape only)."""
    return value.startswith(ACCESS_TOKEN_PREFIX) and len(value) > len(ACCESS_TOKEN_PREFIX)


def mask_secret(value: str, *, visible: int = 4) -> str:
    """Mask a credential, keeping only the last `visible` characters.

    Returns an all-mask placeholder when the value is too short to reveal a
    suffix without revealing most of the secret.
    """
    if len(value) <= visible * 2:
        return "*" * max(len(value), visible)
    return f"{'*' * (len(value) - visible)}{value[-visible:]}"
