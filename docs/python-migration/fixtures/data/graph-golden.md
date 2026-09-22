# Graph golden fixture (Phase 4)

A deterministic 4-node graph for comparing TypeScript vs Python graph results.

```text
A ── B ── C
     │
     D
```

Confirmed, bidirectional `manual` edges, strength 0.8, confidence 1.0:

| source | target |
| --- | --- |
| A | B |
| B | C |
| B | D |

Expected (undirected simple graph, pending/rejected excluded):

| Metric | Value |
| --- | --- |
| nodes | 4 |
| edges | 3 |
| connected components | 1 |
| degree(A) | 1 |
| degree(B) | 3 (hub) |
| degree(C) | 1 |
| degree(D) | 1 |
| betweenness(B) | highest (bridge of A/C/D) |
| shortest A→C | A–B–C (2 hops) |
| shortest A→D | A–B–D (2 hops) |
| path score | `0.6 × weakestTie + 0.4 × mean(hop minStrength × minConfidence)` |

Contact relationship scores for path ranking (0–1 column):

| id | relationshipScore |
| --- | --- |
| A | 0.90 |
| B | 0.82 |
| C | 0.50 |
| D | 0.40 |

A pending inferred edge `C–D` must **not** appear in default analysis (`status: confirmed` only).
