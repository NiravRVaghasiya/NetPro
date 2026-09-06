import {
  MAX_PROFILE_BYTES,
  PROFILE_LIMITS,
  ProfileValidationError,
  type ProfileCard,
  type ProfileLink,
} from "./types";

const TEXT_FIELDS = [
  "fullName",
  "headline",
  "bio",
  "company",
  "role",
  "location",
  "email",
  "phone",
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControls(value: string, multiline = false): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0)!;
    return (
      (code < 32 && !(multiline && code === 10)) ||
      (code >= 127 && code <= 159) ||
      // Array.from iterates code points, so these are unpaired UTF-16 surrogates.
      (code >= 0xd800 && code <= 0xdfff) ||
      (!multiline && (code === 0x2028 || code === 0x2029))
    );
  });
}

function text(
  value: unknown,
  field: string,
  limit: number,
  multiline = false,
): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ProfileValidationError(`${field} must be text.`);
  }
  const normalized = multiline ? value.replace(/\r\n?/g, "\n") : value;
  if (hasControls(normalized, multiline)) {
    throw new ProfileValidationError(
      `${field} contains unsupported control characters.`,
    );
  }
  const trimmed = normalized.trim();
  if (trimmed.length > limit) {
    throw new ProfileValidationError(
      `${field} must be ${limit} characters or fewer.`,
    );
  }
  return trimmed;
}

/** Safe in a client preview as well as validated, persisted output. No URL fetches. */
export function safeProfileUrl(value: string): string | null {
  const candidate = value.trim();
  if (
    !/^https?:\/\//i.test(candidate) ||
    /\s/.test(candidate) ||
    hasControls(candidate) ||
    candidate.length > PROFILE_LIMITS.linkUrl
  )
    return null;
  try {
    const url = new URL(candidate);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    )
      return null;
    const normalized = url.toString();
    return normalized.length <= PROFILE_LIMITS.linkUrl ? normalized : null;
  } catch {
    return null;
  }
}

function links(value: unknown): ProfileLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROFILE_LIMITS.links) {
    throw new ProfileValidationError(
      `links must be a list of at most ${PROFILE_LIMITS.links} links.`,
    );
  }
  return value.map((link) => {
    if (
      !object(link) ||
      Object.keys(link).some((key) => key !== "label" && key !== "url")
    ) {
      throw new ProfileValidationError(
        "Each link must contain only a label and URL.",
      );
    }
    const label = text(link.label, "Link label", PROFILE_LIMITS.linkLabel);
    const rawUrl = text(link.url, "Link URL", PROFILE_LIMITS.linkUrl);
    if (!label) throw new ProfileValidationError("Each link needs a label.");
    const url = safeProfileUrl(rawUrl);
    if (!url) {
      throw new ProfileValidationError(
        "Links must use absolute HTTP(S) URLs without credentials or whitespace.",
      );
    }
    return { label, url };
  });
}

/** Strict allowlist: never publish an imported contact or arbitrary object wholesale. */
export function validateProfileCard(input: unknown): ProfileCard {
  if (!object(input))
    throw new ProfileValidationError("Profile must be a JSON object.");
  const allowed: readonly string[] = [...TEXT_FIELDS, "links"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ProfileValidationError(
      "Profile contains unsupported fields. Only public card details are accepted.",
    );
  }
  const fields = {} as Record<(typeof TEXT_FIELDS)[number], string>;
  for (const field of TEXT_FIELDS) {
    fields[field] = text(
      input[field],
      field,
      PROFILE_LIMITS[field],
      field === "bio",
    );
  }
  if (!fields.fullName)
    throw new ProfileValidationError("fullName is required.");
  if (fields.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fields.email)) {
    throw new ProfileValidationError("email must be a valid email address.");
  }
  if (
    fields.phone &&
    (!/^\+?[0-9(). -]+$/.test(fields.phone) ||
      fields.phone.replace(/\D/g, "").length < 3)
  ) {
    throw new ProfileValidationError(
      "phone must contain a phone number (digits, spaces, parentheses, + or -).",
    );
  }
  return { ...fields, links: links(input.links) };
}

export function parseProfileCardJson(json: string): ProfileCard {
  if (new TextEncoder().encode(json).byteLength > MAX_PROFILE_BYTES) {
    throw new ProfileValidationError("Profile JSON must be 32 KiB or smaller.");
  }
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new ProfileValidationError("Profile must be valid JSON.");
  }
  return validateProfileCard(input);
}
