// packages/core/src/analytics/index.ts
//
// Network analytics engine: metrics, composite score, growth, diversity,
// clusters, and dormant ties — shared by the CLI (`netpro analyze`) and the
// web app (`/dashboard`, `GET /api/analytics`).
export * from "./types";
export * from "./metrics";
export * from "./growth";
export * from "./clusters";
export * from "./dormant";
export * from "./overview";

// v2.0 Phase 2: the analytics entry points gained graph companions — the
// plan asks `analytics/index.ts` to surface them next to `getNetworkOverview`
// so consumers of the analytics namespace find the graph story in one place.
// (Implementation lives in ../graph — this is a pointer, not a second copy.)
export {
  getCommunities,
  getCentrality,
  getNetworkGraph,
  findIntroPaths,
  planIntroPaths,
  getContactGraphPosition,
  louvain,
  modularityOf,
} from "../graph";
export type {
  NetworkGraph,
  CommunitiesInfo,
  CommunityInfo,
  CentralityInfo,
  WarmIntroCandidate,
  FindIntroPathsResult,
  IntroPath,
  LouvainResult,
  IntroPathPlan,
  RankedIntroPath,
  ContactGraphPosition,
} from "../graph";
