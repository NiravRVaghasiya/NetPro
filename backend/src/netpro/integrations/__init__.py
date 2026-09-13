"""Integrations layer — external providers (migration Phases 6-8).

LinkedIn CSV import, enrichment (Hunter / PDL / Clearbit), AI drafting
(OpenAI-compatible / Anthropic), embeddings and event/content feeds — each
behind an explicit ``Protocol`` interface so provider-specific logic can
never leak into domain code, and every provider failure degrades gracefully
(the everything-optional posture: with zero keys, NetPro still works).

Provider credentials are BYO-key, stored via the encrypted key vault, never
logged, never returned raw, never in URLs or localStorage — enforced by
automated tests in Phase 15.

Nothing lives here yet — Phase 1 ships no production feature on purpose.
"""
