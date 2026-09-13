"""Application layer — use cases (one rule, one implementation).

Composes domain rules with infrastructure (repositories, providers) into the
operations every surface offers: ``record_interaction()``,
``complete_followup()``, ``search_contacts()``, ``analyze_graph()`` …

The layer exists to enforce the plan's §2.2 invariant: the web UI, the HTTP
API and the CLI are *interfaces*, never owners of business logic::

    UI / API / CLI
         ↓
    application use case   ← the only place a rule is implemented
         ↓
    domain  →  repository

Nothing lives here yet — Phase 1 ships no production feature on purpose.
"""
