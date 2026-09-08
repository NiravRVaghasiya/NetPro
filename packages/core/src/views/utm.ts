// v2.5 Phase 2 — campaign attribution for the profile-view beacon.
//
// `utm_source` / `utm_medium` / `utm_campaign` are stored per view so the
// owner can answer "which post / channel sent people to my card". The
// parameters come from two places, in priority order:
//
//   1. Explicit beacon query params on the pixel / JSON endpoint
//      (`/api/card/pixel.gif?utm_source=…`) — the embed snippet may carry
//      them alongside the referrer.
//   2. The referrer URL's own query string (a normal page visit where the
//      referring site forwards UTM params, which most sites do).
//
// Every value is trimmed and capped at 100 chars; empty or missing values
// become `null`. Only the three columns that exist in `profile_views` are
// read — `utm_term` / `utm_content` are intentionally ignored (no column,
// no analysis, no storage).
export const UTM_MAX_LENGTH = 100;

export interface UtmValues {
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

export const EMPTY_UTM: UtmValues = { source: null, medium: null, campaign: null };

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, UTM_MAX_LENGTH);
}

function fromParams(params: URLSearchParams): UtmValues {
  return {
    source: clean(params.get('utm_source')),
    medium: clean(params.get('utm_medium')),
    campaign: clean(params.get('utm_campaign')),
  };
}

/**
 * Extract capped UTM values from a raw URL string (e.g. the raw referrer,
 * query intact) or from already-parsed query params / a record. Input that
 * cannot be parsed contributes `null` values — UTM parsing must never throw
 * on a beacon request.
 */
export function parseUtm(
  input:
    | string
    | URLSearchParams
    | Record<string, string | null | undefined>
    | null
    | undefined,
): UtmValues {
  if (input == null) return EMPTY_UTM;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return EMPTY_UTM;
    try {
      return fromParams(new URL(trimmed).searchParams);
    } catch {
      // Not a full URL — treat it as a bare query string.
      try {
        return fromParams(new URLSearchParams(trimmed));
      } catch {
        return EMPTY_UTM;
      }
    }
  }
  if (input instanceof URLSearchParams) return fromParams(input);
  return {
    source: clean(input.utm_source),
    medium: clean(input.utm_medium),
    campaign: clean(input.utm_campaign),
  };
}

/**
 * Merge two UTM readings with priority: the first non-null value of each
 * field wins, so an explicit beacon param beats the referrer's own query.
 */
export function mergeUtm(primary: UtmValues, fallback: UtmValues): UtmValues {
  return {
    source: primary.source ?? fallback.source,
    medium: primary.medium ?? fallback.medium,
    campaign: primary.campaign ?? fallback.campaign,
  };
}
