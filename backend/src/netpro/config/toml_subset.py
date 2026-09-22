"""A small, strict TOML subset — the same one the TypeScript CLI accepts.

`~/.netpro/config.toml` is intentionally simple, so rather than pull in a TOML
dependency for it, NetPro parses exactly the subset it needs: `[section]`
headers, `key = value` pairs (strings, integers, floats, booleans), `#`
comments, and blank lines. Anything outside the subset is a **loud** error with
a line number — never a silently ignored key. A typo in a security setting must
stop the process, not quietly leave the default in force.

Ported from `packages/db/src/local.ts` (`parseToml`). Error messages are kept
byte-identical on purpose: during the migration both implementations read the
same file on the same machine, and a user should get the same sentence from
either one.
"""

from __future__ import annotations

import re

__all__ = [
    "TomlSubsetError",
    "TomlTable",
    "TomlValue",
    "parse_toml",
]

#: Values the subset understands.
TomlValue = str | int | float | bool

#: A parsed document: section name → (key → value). Top-level keys are allowed
#: and land in the returned table directly, as in the TypeScript parser.
TomlTable = dict[str, TomlValue | dict[str, TomlValue]]

_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
_INTEGER = re.compile(r"^[+-]?[0-9]+$")
_FLOAT_PLAIN = re.compile(r"^[+-]?([0-9]+\.[0-9]+|\.[0-9]+|[0-9]+\.)([eE][+-]?[0-9]+)?$")
_FLOAT_EXPONENT = re.compile(r"^[+-]?([0-9]+(\.[0-9]+)?)([eE][+-]?[0-9]+)$")
_HEX = re.compile(r"^[0-9a-fA-F]+$")

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}


class TomlSubsetError(ValueError):
    """A `config.toml` line the subset does not accept."""

    def __init__(self, message: str, line: int) -> None:
        """Record the offending fragment and its 1-based line number."""
        self.message = message
        self.line = line
        super().__init__(f"config.toml line {line}: {message}")


def parse_toml(text: str) -> TomlTable:
    """Parse the NetPro config subset.

    Raises `TomlSubsetError` (with a 1-based line number) for multi-line
    values, arrays, inline tables, dotted keys, duplicate keys/tables, unknown
    escapes, and unterminated strings.
    """
    table: TomlTable = {}
    current: dict[str, TomlValue] = {}
    top_level = True

    for index, raw_line in enumerate(text.split("\n")):
        line_no = index + 1
        line = strip_comment(raw_line.rstrip("\r")).strip()
        if not line:
            continue

        if line.startswith("["):
            if not line.endswith("]"):
                raise TomlSubsetError('unterminated table header (missing "]")', line_no)
            name = line[1:-1].strip()
            if not name:
                raise TomlSubsetError("empty table header", line_no)
            if "." in name:
                raise TomlSubsetError(
                    "dotted table names are not supported by NetPro's config subset",
                    line_no,
                )
            if not _BARE_KEY.match(name):
                raise TomlSubsetError(f'invalid table name "{name}"', line_no)
            if name in table:
                raise TomlSubsetError(f"table [{name}] is defined more than once", line_no)
            section: dict[str, TomlValue] = {}
            table[name] = section
            current = section
            top_level = False
            continue

        equals = line.find("=")
        if equals == -1:
            raise TomlSubsetError(f'expected "key = value", got "{line}"', line_no)
        key = line[:equals].strip()
        if not _BARE_KEY.match(key):
            raise TomlSubsetError(f'invalid key "{key}"', line_no)
        target: dict[str, TomlValue] = current
        if key in target:
            raise TomlSubsetError(f'duplicate key "{key}"', line_no)
        raw_value = line[equals + 1 :].strip()
        if raw_value.startswith(("[", "{", '"""', "'''")):
            raise TomlSubsetError(
                "multi-line values, arrays, and inline tables are not supported "
                "by NetPro's config subset",
                line_no,
            )
        value = _parse_value(raw_value, line_no)
        if top_level and key in table:
            # A bare key cannot shadow a section header.
            raise TomlSubsetError(f'duplicate key "{key}"', line_no)
        if top_level:
            table[key] = value
        else:
            target[key] = value

    return table


def strip_comment(line: str) -> str:
    """Strip a `#` comment, respecting `#` inside quoted strings."""
    in_basic = False
    in_literal = False
    for index, char in enumerate(line):
        if char == '"' and not in_literal:
            in_basic = not in_basic
        elif char == "'" and not in_basic:
            in_literal = not in_literal
        elif char == "#" and not in_basic and not in_literal:
            return line[:index]
    return line


def _parse_value(raw: str, line: int) -> TomlValue:
    value = raw.strip()
    if not value:
        raise TomlSubsetError('missing value after "="', line)
    if value == "true":
        return True
    if value == "false":
        return False
    first = value[0]
    if first in {'"', "'"}:
        return _parse_string(value, line)
    if _INTEGER.match(value):
        return int(value)
    if _FLOAT_PLAIN.match(value) or _FLOAT_EXPONENT.match(value):
        return float(value)
    raise TomlSubsetError(
        f'unsupported value "{value}" '
        "(NetPro's config subset allows strings, numbers, and booleans)",
        line,
    )


def _parse_string(raw: str, line: int) -> str:
    if raw.startswith("'"):
        # Literal string: no escapes, ends at the next single quote.
        if len(raw) < 2 or not raw.endswith("'"):
            raise TomlSubsetError("unterminated literal string (missing closing ')", line)
        return raw[1:-1]

    if not raw.startswith('"'):
        raise TomlSubsetError(f"expected a string, got {raw}", line)
    if len(raw) < 2 or not raw.endswith('"'):
        raise TomlSubsetError('unterminated string (missing closing ")', line)

    body = raw[1:-1]
    out: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue

        index += 1
        if index >= len(body):
            raise TomlSubsetError("dangling backslash in string", line)
        escape = body[index]
        if escape in _ESCAPES:
            out.append(_ESCAPES[escape])
            index += 1
            continue
        if escape in {"u", "U"}:
            width = 4 if escape == "u" else 8
            digits = body[index + 1 : index + 1 + width]
            if not _HEX.match(digits):
                raise TomlSubsetError(f"invalid unicode escape \\{escape}{digits}", line)
            out.append(chr(int(digits, 16)))
            index += 1 + width
            continue
        raise TomlSubsetError(f"unsupported escape \\{escape}", line)

    return "".join(out)
