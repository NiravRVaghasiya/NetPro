"""Integrations: LinkedIn import, AI drafting, enrichment, content.

Empty in Phase 1 by design. When these arrive (Phases 6–8) they keep the
existing product rules:

- **LinkedIn** is parsed from a user-provided CSV and from a profile URL
  syntactically. **No scraping, ever** (`import/linkedin-url.ts` rejects
  lookalike hosts).
- **AI providers** draft only. NetPro never sends: no SMTP, no stored mailbox,
  no background send.
- **Enrichment** providers are optional, BYO-key, explicitly invoked, cached,
  and rate-limited. Keys live in the environment, the CLI keychain, or the
  AES-256-GCM vault; reads return the last four characters only.
- Every outbound HTTP call goes through one client that enforces the SSRF
  rules from `docs/python-migration/migration-rules.md` §10.
"""

from __future__ import annotations
