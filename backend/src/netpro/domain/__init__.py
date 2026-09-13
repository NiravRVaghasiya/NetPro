"""Domain layer — NetPro's business rules (migration Phase 3).

Will hold the pure, framework-free heart of the product: Person,
Relationship, Interaction, FollowUp, Workspace, Tag, Skill and the rules the
plan freezes as behavior contracts:

* relationship scoring — the documented formula
  (recency 40% / frequency 25% / depth 20% / richness 15%, stored 0-1),
  ported with golden tests lifted from ``packages/core/src/crm/scoring.test.ts``
* dormancy detection, follow-up lifecycle, interaction recording
* duplicate identity (LinkedIn ``usernameKey``, email identity)
* workspace ownership and relationship state

Domain code must import nothing from ``netpro.api``, ``netpro.cli`` or any
framework — the Phase 3 exit criterion is that core rules execute without
FastAPI or frontend code anywhere in the import graph.
"""
