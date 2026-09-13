"""Configuration for the Python platform.

Exports :class:`Settings` (environment-backed, TS-compatible) and the cached
:func:`get_settings` accessor. ``~/.netpro/config.toml`` support arrives with
Phase 2's persistence layer, matching the TS precedence exactly:
environment → config file → local-first defaults.
"""

from __future__ import annotations

from netpro.config.settings import Settings, get_settings

__all__ = ["Settings", "get_settings"]
