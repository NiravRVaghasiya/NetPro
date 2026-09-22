"""The API container: settings, identity, and the dependencies routes use.

Dependency injection here is deliberately boring — a frozen dataclass built
once at startup and attached to `app.state`. There is no registry, no service
locator magic, and no import-time singletons: a test builds its own container
with a fake probe and a fixed clock, and the app under test is the real one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from netpro.application.health import HealthProbe, HealthQuery, LatencyHealthProbe
from netpro.config.settings import Settings, load_settings
from netpro.domain.ports import Clock, SystemClock

__all__ = ["DEFAULT_HEALTH_PATH", "ServerIdentity", "build_container"]

#: The health path advertised by `/api/server-info`.
DEFAULT_HEALTH_PATH: Final = "/api/health"


@dataclass(frozen=True, slots=True)
class ServerIdentity:
    """What `/api/server-info` says about itself.

    `service` keeps the frozen contract value (`@netpro/server`) so an existing
    UI does not have to branch on which implementation answered; `implementation`
    is the additive field that tells the truth about this process.
    """

    name: str = "NetPro"
    service: str = "@netpro/server"
    message: str = "Local-first NetPro HTTP server"
    health_path: str = DEFAULT_HEALTH_PATH
    implementation: str = "python"
    version: str = ""


@dataclass(frozen=True, slots=True)
class ApiContainer:
    """Everything a route may depend on."""

    settings: Settings
    identity: ServerIdentity
    health_probe: HealthProbe
    clock: Clock

    @property
    def health_query(self) -> HealthQuery:
        """The health use case, bound to this container's probe and clock."""
        return HealthQuery(
            dialect=self.settings.database.dialect,
            probe=self.health_probe,
            clock=self.clock,
        )


def build_container(
    settings: Settings | None = None,
    *,
    identity: ServerIdentity | None = None,
    health_probe: HealthProbe | None = None,
    clock: Clock | None = None,
    version: str = "",
) -> ApiContainer:
    """Build a container, resolving settings from the environment when absent."""
    return ApiContainer(
        settings=settings if settings is not None else load_settings(),
        identity=identity if identity is not None else ServerIdentity(version=version),
        health_probe=health_probe if health_probe is not None else LatencyHealthProbe(),
        clock=clock if clock is not None else SystemClock(),
    )
