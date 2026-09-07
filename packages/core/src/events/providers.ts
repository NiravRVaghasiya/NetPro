// packages/core/src/events/providers.ts
//
// The seam for the blueprint's "event discovery" half of this feature, which
// is deliberately NOT built in v2.0.
//
// NetPro's posture is that a single-owner tool should not ship a network call
// it cannot justify: scraping Luma or Eventbrite means rate limits, terms of
// service, and a moving target, all to suggest conferences you can already
// find. What ships instead is the *interface* and a disabled default, so a
// future phase — or a fork — can add a provider without touching the core,
// the CLI, or the web surface: implement `EventDiscoveryProvider`, hand it to
// `resolveEventProvider`, and the rest of the module is unchanged.
//
// Nothing here touches the network, and no code path in v2.0 calls `discover`.
export interface DiscoveredEvent {
  name: string;
  location?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  url?: string | null;
}

export interface EventDiscoveryQuery {
  /** Free-text topic ("postgres", "rust"). */
  query?: string;
  location?: string;
  limit?: number;
}

export interface EventDiscoveryProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Optional: a disabled provider is a value, not an error. */
  discover?: (query: EventDiscoveryQuery) => Promise<DiscoveredEvent[]>;
}

/** The default: no discovery, no network, no configuration to get wrong. */
export const DISABLED_EVENT_PROVIDER: EventDiscoveryProvider = {
  name: 'disabled',
  enabled: false,
};

/**
 * Use `candidate` only when it is present and enabled; otherwise the disabled
 * default. Callers never have to null-check.
 */
export function resolveEventProvider(
  candidate?: EventDiscoveryProvider | null
): EventDiscoveryProvider {
  return candidate && candidate.enabled === true ? candidate : DISABLED_EVENT_PROVIDER;
}

/** True when a provider could actually answer a discovery query right now. */
export function canDiscover(provider: EventDiscoveryProvider): boolean {
  return provider.enabled === true && typeof provider.discover === 'function';
}
