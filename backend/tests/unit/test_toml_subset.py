from __future__ import annotations

import pytest

from netpro.config.toml_subset import TomlSubsetError, parse_toml


def test_parses_the_shape_netpro_ships() -> None:
    text = """
# NetPro local configuration

[database]
dialect = "sqlite"
path = "netpro.db"

[server]
host = "127.0.0.1"
port = 3777

[auth]
mode = "local"

[installation]
id = "ins_0f1e2d3c4b5a69788796a5b4"
created_at = "2026-09-22T00:00:00.000Z"
owner = "Ada Lovelace"
"""
    table = parse_toml(text)
    assert table["database"] == {"dialect": "sqlite", "path": "netpro.db"}
    assert table["server"] == {"host": "127.0.0.1", "port": 3777}
    assert table["auth"] == {"mode": "local"}
    installation = table["installation"]
    assert isinstance(installation, dict)
    assert installation["owner"] == "Ada Lovelace"


def test_value_types() -> None:
    table = parse_toml(
        'a = "text"\nb = 42\nc = -7\nd = 1.5\ne = .25\nf = 3e2\ng = true\nh = false\n'
    )
    assert table == {
        "a": "text",
        "b": 42,
        "c": -7,
        "d": 1.5,
        "e": 0.25,
        "f": 300.0,
        "g": True,
        "h": False,
    }


def test_comments_are_stripped_outside_strings() -> None:
    table = parse_toml('url = "https://x.test/#anchor" # trailing\n# whole line\n')
    assert table == {"url": "https://x.test/#anchor"}


def test_escapes() -> None:
    table = parse_toml(r'a = "line\nbreak\ttab \"quoted\" \\ back \u0041 \U0001F600"')
    assert table["a"] == 'line\nbreak\ttab "quoted" \\ back A \U0001f600'


def test_literal_strings_do_not_process_escapes() -> None:
    assert parse_toml(r"a = 'C:\path\no-escape'") == {"a": "C:\\path\\no-escape"}


@pytest.mark.parametrize(
    ("line", "message", "line_no"),
    [
        ("[database", 'unterminated table header (missing "]")', 1),
        ("[]", "empty table header", 1),
        ("[a.b]", "dotted table names are not supported by NetPro's config subset", 1),
        ("[bad name]", 'invalid table name "bad name"', 1),
        ("nope", 'expected "key = value", got "nope"', 1),
        ("bad key = 1", 'invalid key "bad key"', 1),
        ("a = 1\na = 2", 'duplicate key "a"', 2),
        ("[s]\n[s]", "table [s] is defined more than once", 2),
        (
            "a = [1, 2]",
            "multi-line values, arrays, and inline tables are not supported "
            "by NetPro's config subset",
            1,
        ),
        (
            "a = { b = 1 }",
            "multi-line values, arrays, and inline tables are not supported "
            "by NetPro's config subset",
            1,
        ),
        ('a = "unterminated', 'unterminated string (missing closing ")', 1),
        ("a = 'unterminated", "unterminated literal string (missing closing ')", 1),
        (r'a = "abc\"', "dangling backslash in string", 1),
        ('a = "\\q"', "unsupported escape \\q", 1),
        ('a = "\\uZZZZ"', "invalid unicode escape \\uZZZZ", 1),
        ("a =", 'missing value after "="', 1),
        (
            "a = maybe",
            'unsupported value "maybe" '
            "(NetPro's config subset allows strings, numbers, and booleans)",
            1,
        ),
        ("nope", 'config.toml line 1: expected "key = value", got "nope"', None),
    ],
)
def test_errors_carry_the_frozen_message(line: str, message: str, line_no: int | None) -> None:
    with pytest.raises(TomlSubsetError) as excinfo:
        parse_toml(line)
    error = excinfo.value
    if line_no is None:
        # The sentinel row asserts the rendered message, not the fragment.
        assert str(error) == message
    else:
        assert error.message == message
        assert error.line == line_no
        assert str(error) == f"config.toml line {line_no}: {message}"


def test_error_reports_the_offending_line() -> None:
    text = '[server]\nhost = "127.0.0.1"\nport =\n'

    with pytest.raises(TomlSubsetError) as excinfo:
        parse_toml(text)

    assert excinfo.value.line == 3
    assert str(excinfo.value) == 'config.toml line 3: missing value after "="'
    assert parse_toml('[server]\nport = "3777"\n') == {"server": {"port": "3777"}}


def test_crlf_line_endings() -> None:
    assert parse_toml("[s]\r\na = 1\r\n") == {"s": {"a": 1}}


def test_empty_document() -> None:
    assert parse_toml("") == {}
