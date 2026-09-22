"""Intelligence: graph analytics and search ranking.

Empty in Phase 1 by design. This is where Python earns its place in the
product:

- **Phase 4 — graph.** `load_graph` (trust rules: `rejected` never loaded,
  `pending` excluded by default), Louvain communities, degree + Brandes
  betweenness, connected components, and the warm-intro pathfinder scored
  `0.6 × weakestTie + 0.4 × mean(hopStrength)`.
- **Phase 5 — search.** Portable / keyword / hybrid arms fused with
  reciprocal rank fusion at **k = 60**, degradation reasons instead of
  failures, and per-hit `matchReasons` for explainability.

Both phases land only after golden-test parity with the TypeScript results in
`docs/python-migration/fixtures/data/graph-golden.md`.
"""

from __future__ import annotations
