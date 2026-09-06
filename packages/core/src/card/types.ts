/** Deliberately independent of contacts and OAuth users: every field is public. */
export interface ProfileLink {
  label: string;
  url: string;
}

export interface ProfileCard {
  fullName: string;
  headline: string;
  bio: string;
  company: string;
  role: string;
  location: string;
  email: string;
  phone: string;
  links: ProfileLink[];
}

/** Owner-only state. Never pass this object to a public component. */
export interface ProfileCardState {
  draft: ProfileCard | null;
  published: ProfileCard | null;
  publishedAt: string | null;
  updatedAt: string | null;
}

export const PROFILE_LIMITS = {
  fullName: 120,
  headline: 160,
  bio: 2000,
  company: 120,
  role: 120,
  location: 160,
  email: 254,
  phone: 40,
  linkLabel: 40,
  linkUrl: 2048,
  links: 6,
} as const;

export const MAX_PROFILE_BYTES = 32 * 1024;

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}
