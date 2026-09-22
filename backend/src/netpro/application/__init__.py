"""Application layer: use cases. One operation → one implementation here.

Routes, CLI commands, and job runners are adapters. Nothing in this layer
imports FastAPI, Typer, SQLAlchemy, or `netpro.api`.
"""

from __future__ import annotations

from netpro.application.health import (
    HealthOutcome,
    HealthProbe,
    HealthQuery,
    HealthReport,
    HealthRequest,
    HealthStatus,
    LatencyHealthProbe,
    MigrationState,
    ProbeResult,
    SearchCapability,
)
from netpro.application.usecase import AsyncUseCase, UseCase

__all__ = [
    "AsyncUseCase",
    "HealthOutcome",
    "HealthProbe",
    "HealthQuery",
    "HealthReport",
    "HealthRequest",
    "HealthStatus",
    "LatencyHealthProbe",
    "MigrationState",
    "ProbeResult",
    "SearchCapability",
    "UseCase",
]
