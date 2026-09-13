"""Intelligence layer — graph, search and ranking (migration Phases 4-5).

The first *major* migrations, because Python's ecosystem (NetworkX, numpy,
the ML tooling) is exactly why the platform is going Python-first:

* graph construction, connected components, degree centrality, Brandes
  betweenness (with the honest node-budget skip), deterministic Louvain
  communities, BFS chains and the warm-intro pathfinder
  (score = 0.6·weakestTie + 0.4·avgHopStrength — frozen contract);
* hybrid search: substring + full-text + optional semantic arms fused with
  reciprocal rank fusion (k=60, arm weights keyword 1 / semantic 0.9 /
  portable 0.5, deterministic tie-breaks — pagination depends on them).

Subpackages (Phase 4): ``netpro.intelligence.graph`` with builder, models,
communities, centrality, components, paths, metrics, provenance — mirroring
``packages/core/src/graph``. Every algorithm lands with the deterministic
fixtures from the TS tests; where NetworkX's semantics differ (its Louvain
is seeded-random, NetPro's is sorted-id-deterministic), the TS algorithm is
ported directly rather than swapped for a library.
"""
