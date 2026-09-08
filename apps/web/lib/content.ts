// apps/web/lib/content.ts
//
// Tiny presentational helpers shared by the /content pages and the dashboard
// strip. Display only — parsing and limits live in lib/content-request.ts
// and the core module.

const PLATFORM_LABELS: Record<string, string> = {
  blog: "Blog",
  twitter: "Twitter",
  x: "X",
  devto: "dev.to",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  github: "GitHub",
  manual: "Manual",
  rss: "RSS",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Thousands separators for engagement counts ("1,240"). */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US");
}
