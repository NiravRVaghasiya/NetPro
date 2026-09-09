// packages/core/src/content/index.ts
//
// v2.5 Phase 4 — the content cross-posting tracker: "what did I publish, and
// how is each piece doing".
//
// The schema (`content_items`, `content_metrics`, `content_mentions`) ships in
// migration `0007`; this phase is the model plus the provider seam. The CLI
// (`netpro content`), the web (`/content`) and the API all read the same
// functions in Phase 5, so all three surfaces agree:
//
//   * `types.ts` — platforms, sources, limits, errors, record shapes.
//   * `urls.ts` — the one URL canonicalizer: validation, dedupe keys,
//     platform detection.
//   * `parse.ts` — CSV + RSS/Atom readers (pure) and the bounded feed fetch.
//   * `providers.ts` — the provider interface: `manual` + `rss` built in,
//     `devto`/`twitter`/`github` as disabled, self-explaining stubs.
//   * `repository.ts` — items, metrics snapshots, mentions, import, overview.
export * from "./types";
export * from "./urls";
export * from "./parse";
export * from "./providers";
export * from "./repository";
// v2.5 Phase 6 — the 365-day content-snapshot retention query (the latest
// snapshot per item always survives); scheduled by `../retention`.
export * from "./retention";
