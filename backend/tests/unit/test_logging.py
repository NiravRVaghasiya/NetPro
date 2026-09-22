from __future__ import annotations

import json
import logging

from netpro.infrastructure.logging import (
    REDACTED,
    configure_logging,
    get_logger,
    redact,
    structured_extra,
)


class Collector(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(self.format(record))


def test_known_credential_shapes_are_redacted() -> None:
    text = (
        "saving token np_2c9Xk1mNqLpRsTuVwXyZ0123456789abcdefABCDEFG "
        "and key sk-abcdefghijklmnopqrstuvwx for hunter_AbCdEfGhIjKlMnOpQrSt"
    )

    scrubbed = redact(text)

    assert "np_2c9Xk1mNqLpRsTuVwXyZ" not in scrubbed
    assert "sk-abcdefghijklmnop" not in scrubbed
    assert scrubbed.count(REDACTED) == 3


def test_ordinary_text_is_left_alone() -> None:
    text = "imported 42 contacts from linkedin.csv (np_total 42)"

    assert redact(text) == text


def test_the_handler_never_emits_a_raw_credential() -> None:
    collector = Collector()
    collector.setFormatter(logging.Formatter("%(message)s"))

    from netpro.infrastructure.logging import RedactingFilter

    collector.addFilter(RedactingFilter())
    logger = logging.getLogger("netpro.test.credentials")
    logger.handlers = [collector]
    logger.setLevel(logging.INFO)
    logger.propagate = False

    logger.info("resolved key %s", "sk-abcdefghijklmnopqrstuvwx")

    assert len(collector.records) == 1
    assert "sk-abcdefghijklmnop" not in collector.records[0]
    assert REDACTED in collector.records[0]


def test_configure_logging_emits_structured_json() -> None:
    import io

    stream = io.StringIO()
    logger = configure_logging(level="INFO", json_output=True, stream=stream)

    logger.info("job finished", extra=structured_extra(request_id="req-1", job_id="job-1"))

    payload = json.loads(stream.getvalue().strip())
    assert payload["level"] == "info"
    assert payload["logger"] == "netpro"
    assert payload["message"] == "job finished"
    assert payload["request_id"] == "req-1"
    assert payload["job_id"] == "job-1"
    assert "timestamp" in payload


def test_get_logger_stays_inside_the_netpro_namespace() -> None:
    assert get_logger("api").name == "netpro.api"
    assert get_logger("netpro.jobs").name == "netpro.jobs"


def test_structured_extra_drops_reserved_record_fields() -> None:
    assert structured_extra(request_id="r", msg="ignored", levelname="ignored") == {
        "request_id": "r"
    }
