from __future__ import annotations

import pytest

from netpro.api.request_trust import (
    extract_credential,
    is_direct_loopback_request,
    is_loopback_address,
    resolve_trust,
)


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::1]"],
)
def test_loopback_addresses_are_recognised(address: str) -> None:
    assert is_loopback_address(address) is True


@pytest.mark.parametrize(
    "address",
    ["203.0.113.9", "10.0.0.5", "::ffff:7f01:1", "192.168.1.20", "", None],
)
def test_non_loopback_addresses_are_rejected(address: str | None) -> None:
    assert is_loopback_address(address) is False


def test_a_proxy_header_revokes_loopback_trust() -> None:
    assert is_direct_loopback_request("127.0.0.1", {}) is True
    for header in ("x-forwarded-for", "x-real-ip", "forwarded"):
        assert is_direct_loopback_request("127.0.0.1", {header: "127.0.0.1"}) is False


def test_a_remote_peer_is_never_direct_loopback() -> None:
    assert is_direct_loopback_request("203.0.113.9", {}) is False


def test_local_mode_trusts_a_direct_loopback_caller() -> None:
    trust = resolve_trust(mode="local", client_host="127.0.0.1", headers={})

    assert (trust.authenticated, trust.trusted_local, trust.kind) == (True, True, "loopback")
    assert trust.reason is None


def test_local_mode_denies_a_proxied_loopback_caller() -> None:
    trust = resolve_trust(
        mode="local",
        client_host="127.0.0.1",
        headers={"X-Forwarded-For": "203.0.113.9"},
    )

    assert trust.authenticated is False
    assert trust.trusted_local is False
    assert trust.reason == "missing-credentials"


def test_token_mode_denies_everyone_until_phase_15() -> None:
    trust = resolve_trust(mode="token", client_host="127.0.0.1", headers={})

    assert trust.authenticated is False
    assert trust.kind == "anonymous"


def test_a_presented_credential_changes_the_reason_only() -> None:
    trust = resolve_trust(
        mode="token",
        client_host="127.0.0.1",
        headers={"Authorization": "Bearer np_notavalidtoken"},
    )

    assert trust.authenticated is False
    assert trust.reason == "invalid-credentials"


def test_open_mode_authenticates_without_trusting() -> None:
    trust = resolve_trust(mode="open", client_host="203.0.113.9", headers={})

    assert (trust.authenticated, trust.trusted_local, trust.kind) == (True, False, "open")


@pytest.mark.parametrize(
    ("headers", "query_token", "expected"),
    [
        ({"Authorization": "Bearer np_abc"}, None, "np_abc"),
        ({"authorization": "bearer   np_abc "}, None, "np_abc"),
        ({"X-NetPro-Token": "np_abc"}, None, "np_abc"),
        ({"Authorization": "Basic dXNlcjpwYXNz"}, "np_query", "np_query"),
        ({}, "  ", None),
        ({}, None, None),
    ],
)
def test_credential_extraction_order(
    headers: dict[str, str], query_token: str | None, expected: str | None
) -> None:
    assert extract_credential(headers, query_token) == expected
