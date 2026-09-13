"""Infrastructure layer — persistence and mechanics (migration Phase 2).

Will hold the SQLAlchemy 2 models mapped onto the **existing** NetPro schema
(no redesign — the plan's Phase 2 rule): text UUID keys, ISO-8601 text
timestamps, JSON-in-text columns, ``workspace_id`` on every data table,
SQLite and PostgreSQL as first-class dialects, plus Alembic adopting the
migration history at ``0014`` so existing databases keep working.

The repositories translate between ORM rows and typed domain objects; ORM
objects never leak above the application layer.
"""
