from __future__ import annotations

import pytest

from netpro.domain.errors import (
    NetProError,
    NotFoundError,
    RateLimitedError,
    UnauthorizedError,
    ValidationError,
)
from netpro.domain.ports import UnitOfWork, transaction


def test_error_payload_is_the_api_envelope() -> None:
    error = NotFoundError("Contact not found.")

    assert error.to_payload() == {"error": "Contact not found."}
    assert error.status_code == 404
    assert error.code == "not_found"


def test_the_unauthorized_body_carries_reason_mode_and_hint() -> None:
    error = UnauthorizedError(
        reason="missing-credentials",
        auth_mode="token",
        hint="Send the local access token as `Authorization: Bearer <token>`.",
        token_configured=True,
    )

    assert error.to_payload() == {
        "error": "Unauthorized",
        "reason": "missing-credentials",
        "authMode": "token",
        "hint": "Send the local access token as `Authorization: Bearer <token>`.",
    }
    assert error.headers == {"WWW-Authenticate": 'Bearer realm="netpro"'}
    assert UnauthorizedError().headers == {}


def test_details_merge_into_the_envelope() -> None:
    error = ValidationError("Invalid input.", details={"fields": {"email": "required"}})

    assert error.to_payload() == {
        "error": "Invalid input.",
        "fields": {"email": "required"},
    }


def test_codes_can_be_overridden_at_the_raise_site() -> None:
    error = NetProError("boom", code="weird_thing", status_code=418)

    assert (error.code, error.status_code) == ("weird_thing", 418)


def test_rate_limit_carries_both_spellings_of_the_wait() -> None:
    error = RateLimitedError(retry_after_ms=1500)

    assert error.to_payload() == {
        "error": "Too many requests.",
        "retryAfterMs": 1500,
    }
    assert error.headers == {"Retry-After": "2"}


class RecordingUow:
    def __init__(self, fail_on_commit: bool = False) -> None:
        self.fail_on_commit = fail_on_commit
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def commit(self) -> None:
        if self.fail_on_commit:
            raise RuntimeError("commit failed")
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True


def test_transaction_commits_and_always_closes() -> None:
    uow = RecordingUow()

    with transaction(uow) as active:
        assert active is uow
        assert not uow.committed

    assert (uow.committed, uow.rolled_back, uow.closed) == (True, False, True)


def test_transaction_rolls_back_on_error() -> None:
    uow = RecordingUow()

    with pytest.raises(RuntimeError, match="inside"), transaction(uow):
        raise RuntimeError("inside")

    assert (uow.committed, uow.rolled_back, uow.closed) == (False, True, True)


def test_transaction_rolls_back_when_commit_fails() -> None:
    uow = RecordingUow(fail_on_commit=True)

    with pytest.raises(RuntimeError, match="commit failed"), transaction(uow):
        pass

    assert (uow.rolled_back, uow.closed) == (True, True)


def test_a_unit_of_work_satisfies_the_protocol() -> None:
    assert isinstance(RecordingUow(), UnitOfWork)
