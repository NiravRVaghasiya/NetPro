"""Observability: idempotent configuration and request-context propagation."""

from __future__ import annotations

import logging

from netpro.observability import _ContextFilter, configure_logging, get_logger, request_id_var


class TestConfigureLogging:
    def test_is_idempotent_no_duplicate_handlers(self) -> None:
        configure_logging("INFO")
        before = len(logging.getLogger().handlers)
        configure_logging("DEBUG")
        after = len(logging.getLogger().handlers)
        assert before == after

    def test_sets_level(self) -> None:
        configure_logging("WARNING")
        assert logging.getLogger().level == logging.WARNING


class TestContextFilter:
    def test_injects_request_id_when_set(self) -> None:
        token = request_id_var.set("req-123")
        try:
            record = logging.LogRecord(
                name="netpro.test",
                level=logging.INFO,
                pathname=__file__,
                lineno=1,
                msg="hello",
                args=(),
                exc_info=None,
            )
            assert _ContextFilter().filter(record) is True
            assert record.request_id == "req-123"  # type: ignore[attr-defined]
        finally:
            request_id_var.reset(token)

    def test_renders_dash_outside_a_request(self) -> None:
        record = logging.LogRecord(
            name="netpro.test",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="hello",
            args=(),
            exc_info=None,
        )
        assert _ContextFilter().filter(record) is True
        assert record.request_id == "-"  # type: ignore[attr-defined]


class TestGetLogger:
    def test_namespaces_bare_names(self) -> None:
        assert get_logger("api").name == "netpro.api"

    def test_keeps_netpro_names(self) -> None:
        assert get_logger("netpro.domain").name == "netpro.domain"
