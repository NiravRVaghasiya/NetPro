import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Vite 8 uses Oxc; transform Next's preserved JSX for component render tests.
  oxc: { jsx: { runtime: "automatic" } },
  // Mirrors tsconfig's "@/*" path mapping so route tests can vi.mock('@/lib/db').
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // `next build` (standalone output) copies workspace packages — including
    // their *.test.ts files — into .next/standalone/. Without this exclude,
    // any `npm test` run after a build fails transforming those copies.
    exclude: [...configDefaults.exclude, ".next/**"],
  },
});
