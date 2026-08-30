// `@netpro/config` ships plain JS (no `.d.ts`) for its subpath exports.
// `tailwind.config.ts` is the first place in the workspace that imports
// `@netpro/config/tailwind` from a type-checked `.ts` file, which surfaces
// TS7016 ("implicitly has an 'any' type") without this ambient declaration.
declare module '@netpro/config/tailwind' {
  import type { Config } from 'tailwindcss';

  const preset: Partial<Config>;
  export default preset;
}
