"""Request trust classification — *who is calling*, nothing more.

Ported from the loopback half of `packages/server/src/auth/index.ts`. The rules
are security-sensitive and are reproduced exactly:

- A peer is "direct loopback" only when the socket address is on the loopback
  interface (`127.0.0.0/8`, `::1`, IPv4-mapped `::ffff:127.0.0.1`, Node's hex
  form `::ffff:7f00:1`) **and** no proxy header is present.
- The presence of `X-Forwarded-For`, `X-Real-Ip`, or `Forwarded` **revokes**
  loopback trust. A reverse proxy on the same machine connects from
  127.0.0.1, so the socket address alone would mark every proxied request as
  local. Deliberately conservative: a client can set those headers itself, so
  presence alone is enough to withhold trust. Nobody is locked out — the token
  always works.
- `open` mode authenticates everyone but trusts no one: no credential was
  presented, so the request does not get the diagnostics that name the
  installation.

**Phase 1 does not verify credentials.** There is no token comparison here yet
(that is migration Phase 15), and there are no protected routes for it to
guard. The consequence, stated plainly: `authenticated` is `True` only for a
direct loopback caller in `local` mode or for anyone in `open` mode, so
`GET /api/server-info` reports `authenticationRequired: true` for a remote
caller in `local`/`token` mode even when it holds a valid token. Phase 15
replaces this module's call sites with the full `resolve_auth_context` parity
implementation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

from netpro.config.settings import AuthMode

__all__ = [
    "PROXY_HEADERS",
    "AuthKind",
    "DenialReason",
    "RequestTrust",
    "extract_credential",
    "is_direct_loopback_request",
    "is_loopback_address",
    "resolve_trust",
]

#: Headers that prove a request was forwarded by a proxy.
PROXY_HEADERS: Final[tuple[str, ...]] = ("x-forwarded-for", "x-real-ip", "forwarded")

AuthKind = Literal["loopback", "token", "open", "anonymous"]
DenialReason = Literal["missing-credentials", "invalid-credentials"]

_MAPPED_V4 = re.compile(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$")


@dataclass(frozen=True, slots=True)
class RequestTrust:
    """The answer to "who is calling?" for one request."""

    mode: AuthMode
    #: True when the caller may act (loopback in `local`, or `open`).
    authenticated: bool
    #: True when the caller acts as the owner of this installation.
    trusted_local: bool
    kind: AuthKind
    #: Why an anonymous request was denied.
    reason: DenialReason | None = None


def is_loopback_address(address: str | None) -> bool:
    """Is this socket peer on the loopback interface?

    Accepts IPv4 (`127.0.0.0/8`), IPv6 (`::1`), IPv4-mapped IPv6
    (`::ffff:127.0.0.1`), and the hex form (`::ffff:7f00:1`).
    """
    if not address:
        return False
    value = address.strip().lower().strip("[]")
    if value == "::1" or value.startswith("127."):
        return True
    if value == "::ffff:127.0.0.1":
        return True
    mapped = _MAPPED_V4.match(value)
    if mapped:
        # ::ffff:7f00:0/104 covers the mapped 127.0.0.0/8 range.
        return int(mapped.group(1), 16) == 0x7F00
    return False


def has_proxy_header(headers: dict[str, str] | object) -> bool:
    """True when any proxy header is present (presence, not content)."""
    for header in PROXY_HEADERS:
        value = _read_header(headers, header)
        if value:
            return True
    return False


def is_direct_loopback_request(
    client_host: str | None,
    headers: dict[str, str] | object,
) -> bool:
    """True for a loopback peer that did not arrive through a proxy."""
    if not is_loopback_address(client_host):
        return False
    return not has_proxy_header(headers)


def extract_credential(
    headers: dict[str, str] | object,
    query_token: str | None = None,
) -> str | None:
    """Extract a presented credential: bearer header, NetPro header, or query.

    `?token=` exists for browser `EventSource`, which cannot set headers. It is
    never logged, and Phase 1 only uses it to distinguish "no credential" from
    "a credential we cannot verify yet".
    """
    authorization = (_read_header(headers, "authorization") or "").strip()
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            return token.strip()

    explicit = (_read_header(headers, "x-netpro-token") or "").strip()
    if explicit:
        return explicit

    if query_token and query_token.strip():
        return query_token.strip()
    return None


def resolve_trust(
    *,
    mode: AuthMode,
    client_host: str | None,
    headers: dict[str, str] | object,
    query_token: str | None = None,
) -> RequestTrust:
    """Classify one request. Pure: no I/O, no globals."""
    if mode == "open":
        return RequestTrust(
            mode="open",
            authenticated=True,
            trusted_local=False,
            kind="open",
        )

    if mode == "local" and is_direct_loopback_request(client_host, headers):
        return RequestTrust(
            mode="local",
            authenticated=True,
            trusted_local=True,
            kind="loopback",
        )

    # Phase 1 cannot verify a presented token, so a caller that offered one is
    # reported exactly as the TS server reports a token that did not match.
    presented = extract_credential(headers, query_token)
    return RequestTrust(
        mode=mode,
        authenticated=False,
        trusted_local=False,
        kind="anonymous",
        reason="invalid-credentials" if presented else "missing-credentials",
    )


def _read_header(headers: dict[str, str] | object, name: str) -> str | None:
    """Read one header, case-insensitively.

    Starlette's `Headers`, Node's header bag, and a plain dict from a test all
    have to behave the same way: HTTP header names are case-insensitive, so a
    `dict` carrying `X-Forwarded-For` must be seen exactly like `x-forwarded-for`.
    Missing that would silently restore loopback trust behind a proxy.
    """
    target = name.lower()
    getter = getattr(headers, "get", None)
    if callable(getter) and not isinstance(headers, dict):
        value = getter(name)
        return None if value is None else str(value)
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).lower() == target:
                return None if value is None else str(value)
    return None
