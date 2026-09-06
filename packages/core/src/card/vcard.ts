import type { ProfileCard } from "./types";
import { validateProfileCard } from "./validation";

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** RFC 2425: at most 75 octets per physical line, including the folding space. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

export function renderProfileVCard(input: ProfileCard): string {
  const profile = validateProfileCard(input);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeText(profile.fullName)}`,
    // Don't infer a surname from an international display name.
    `N:;${escapeText(profile.fullName)};;;`,
  ];
  if (profile.company) lines.push(`ORG:${escapeText(profile.company)}`);
  if (profile.role || profile.headline)
    lines.push(`TITLE:${escapeText(profile.role || profile.headline)}`);
  if (profile.location)
    lines.push(`LABEL;TYPE=WORK:${escapeText(profile.location)}`);
  if (profile.email)
    lines.push(`EMAIL;TYPE=INTERNET:${escapeText(profile.email)}`);
  if (profile.phone) lines.push(`TEL;TYPE=VOICE:${escapeText(profile.phone)}`);
  if (profile.bio) lines.push(`NOTE:${escapeText(profile.bio)}`);
  for (const link of profile.links) lines.push(`URL:${escapeText(link.url)}`);
  lines.push("END:VCARD");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
