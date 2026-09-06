import { cache } from "react";
import { connection } from "next/server";
import { getPublishedCard } from "@netpro/core/src/card/repository";
import { conn } from "./db";

// React cache deduplicates metadata/page reads within ONE render, not across
// requests. Never use unstable_cache / use cache / ISR for revocable publication.
export const loadPublishedProfile = cache(async () => {
  await connection(); // SQLite reads must not execute during build/prerendering.
  return getPublishedCard(conn);
});
