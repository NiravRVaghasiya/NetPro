from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from netpro.domain.ids import (
    is_access_token,
    is_row_id,
    mask_secret,
    new_access_token,
    new_id,
    new_installation_id,
)
from netpro.domain.paging import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, Page, PageRequest
from netpro.domain.scope import (
    BOOTSTRAP_WORKSPACE_ID,
    SYSTEM_USER_ID,
    WorkspaceScope,
    bootstrap_scope,
    resolve_scope,
)
from netpro.domain.time import now_utc, parse_iso8601, to_iso8601


def test_row_ids_are_lowercase_hyphenated_uuids() -> None:
    value = new_id()
    assert is_row_id(value)
    assert value == value.lower()
    assert value.count("-") == 4
    assert not is_row_id("not-a-uuid")
    assert not is_row_id("")


def test_installation_ids_and_tokens_keep_their_prefixes() -> None:
    installation = new_installation_id()
    token = new_access_token()

    assert installation.startswith("ins_")
    assert len(installation) == len("ins_") + 24
    assert token.startswith("np_")
    # 32 random bytes → 43 base64url characters, unpadded (matches Node).
    assert len(token) == len("np_") + 43
    assert is_access_token(token)
    assert not is_access_token("np_")


def test_mask_secret_keeps_only_the_tail() -> None:
    token = "np_" + "a" * 40
    masked = mask_secret(token)

    assert masked.endswith("aaaa")
    assert masked.count("*") == len(token) - 4
    assert token not in masked
    assert mask_secret("short") == "*****"


def test_timestamps_match_date_to_iso_string() -> None:
    moment = datetime(2026, 9, 22, 13, 45, 6, 789_123, tzinfo=UTC)
    assert to_iso8601(moment) == "2026-09-22T13:45:06.789Z"


def test_sub_millisecond_precision_is_truncated_not_rounded() -> None:
    moment = datetime(2026, 9, 22, 0, 0, 0, 999_999, tzinfo=UTC)
    assert to_iso8601(moment) == "2026-09-22T00:00:00.999Z"


def test_naive_and_offset_timestamps_normalise_to_utc() -> None:
    naive = datetime(2026, 9, 22, 1, 2, 3)
    offset = datetime(2026, 9, 22, 3, 2, 3, tzinfo=timezone(timedelta(hours=2)))

    assert to_iso8601(naive) == "2026-09-22T01:02:03.000Z"
    assert to_iso8601(offset) == "2026-09-22T01:02:03.000Z"


def test_round_trip_through_the_stored_text_form() -> None:
    moment = now_utc()
    assert parse_iso8601(to_iso8601(moment)) == moment.replace(
        microsecond=moment.microsecond // 1000 * 1000
    )
    assert parse_iso8601("2026-09-22T00:00:00.000Z").tzinfo is not None
    assert parse_iso8601("2026-09-22T02:00:00+02:00") == datetime(2026, 9, 22, tzinfo=UTC)
    with pytest.raises(ValueError, match="Invalid isoformat string"):
        parse_iso8601("22 September 2026")


def test_unscoped_callers_resolve_to_the_bootstrap_workspace() -> None:
    scope = resolve_scope(None)

    assert scope.workspace_id == BOOTSTRAP_WORKSPACE_ID == "default"
    assert scope.user_id == SYSTEM_USER_ID == "system"
    assert scope.role == "owner"
    assert scope == bootstrap_scope()


def test_an_explicit_scope_is_passed_through_unchanged() -> None:
    scope = WorkspaceScope(workspace_id="team-a", user_id="user-1", role="member")

    assert resolve_scope(scope) is scope


def test_role_rank_orders_ownership() -> None:
    assert WorkspaceScope(role="owner").at_least("admin")
    assert WorkspaceScope(role="admin").at_least("admin")
    assert not WorkspaceScope(role="viewer").at_least("member")


def test_invalid_scope_is_rejected() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        WorkspaceScope(workspace_id="  ")
    with pytest.raises(ValueError, match="Unknown workspace role"):
        WorkspaceScope(role="superuser")  # type: ignore[arg-type]


def test_page_request_defaults_and_clamps() -> None:
    assert PageRequest.parse() == PageRequest(limit=DEFAULT_PAGE_LIMIT, offset=0)
    assert PageRequest.parse("500").limit == MAX_PAGE_LIMIT
    assert PageRequest.parse("0").limit == 1
    assert PageRequest.parse("-5").limit == 1
    assert PageRequest.parse("abc").limit == DEFAULT_PAGE_LIMIT
    assert PageRequest.parse("10.9").limit == 10
    assert PageRequest.parse(offset="-3").offset == 0
    assert PageRequest(limit=10, offset=20).next_offset == 30
    with pytest.raises(ValueError, match="limit must be between"):
        PageRequest(limit=MAX_PAGE_LIMIT + 1)


def test_page_envelope_repeats_the_contract_metadata() -> None:
    page = Page(items=["a", "b"], total=5, limit=2, offset=0)

    assert page.has_more is True
    assert page.to_envelope("contacts", sort="recent") == {
        "contacts": ["a", "b"],
        "total": 5,
        "limit": 2,
        "offset": 0,
        "sort": "recent",
    }
    assert Page(items=[], total=0, limit=25, offset=0).has_more is False
