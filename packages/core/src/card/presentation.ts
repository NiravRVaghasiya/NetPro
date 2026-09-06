import type { ProfileCard } from "./types";

export function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(parts[0] ?? "N")[0] ?? "N";
  const last = parts.length > 1 ? (Array.from(parts.at(-1)!)[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/** Encode the address, not mail headers: '?' and '&' in a local-part stay data. */
export function profileEmailHref(email: string): string {
  return `mailto:${email.split("@").map(encodeURIComponent).join("@")}`;
}

export function profilePhoneHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

export function profileDescription(profile: ProfileCard): string {
  return (
    profile.headline ||
    profile.bio.replace(/\s+/g, " ").slice(0, 160) ||
    `Connect with ${profile.fullName}.`
  );
}
