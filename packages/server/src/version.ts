// packages/server/src/version.ts
//
// The version the server reports: rendered into the built-in console page
// (`GET /`) and returned by `GET /api/settings`.
//
// It is a literal rather than a `package.json` import because the server is
// bundled by tsup — by the time this code runs there is no manifest next to it
// that describes the release it came from. Keeping it in one module (instead of
// a copy per route) means a version bump touches one line, and
// `version.test.ts` fails if that line and the root `package.json` disagree.

export const SERVER_VERSION = "3.0.2";
