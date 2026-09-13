"""The version is pinned in three places; these tests hold them together.

Same idea as the TS ``apps/cli/src/bundle.test.ts``: the CLI prints a
literal baked at build time, the package metadata says another thing, and
only an assertion keeps them from drifting apart across a release.
"""

from __future__ import annotations

from importlib import metadata

import netpro


def test_package_version_matches_metadata() -> None:
    assert netpro.__version__ == metadata.version("netpro")


def test_version_tracks_the_workspace_release() -> None:
    # The npm release the TypeScript side ships (root package.json, v3.0.2).
    assert netpro.__version__ == "3.0.2"
