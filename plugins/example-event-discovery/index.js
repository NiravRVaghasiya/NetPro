// plugins/example-event-discovery/index.js
// Reference plugin for v3.0 Phase 5 — exercises every capability.
// Offline, deterministic, no real network calls in tests (fetch is mocked).

export const manifest = {
  name: 'example-event-discovery',
  version: '1.0.0',
  engine: '^3.0.0',
  permissions: {
    network: ['api.example.com'],
    capabilities: ['event-discovery', 'command'],
  },
};

export function register(api) {
  // Event discovery provider — offline, returns canned results
  const provider = {
    name: 'example',
    enabled: true,
    async discover(query) {
      const location = api.getSetting('default_location') || query.location || 'San Francisco';
      // Demonstrate secret access (vault)
      const secret = await api.getSecret('api_key');
      api.log('info', 'example plugin discover called', { query: query.query, location, hasSecret: Boolean(secret) });

      // Demonstrate fetch wrapper — would be blocked if host not allowed
      // In real use, this would call api.fetch('https://api.example.com/events?...')
      // For offline tests, we return canned data without network.

      const q = (query.query || '').toLowerCase();
      const all = [
        { name: 'ExampleConf 2026', location: 'San Francisco', startsAt: '2026-10-01', url: 'https://example.com/conf' },
        { name: 'NetPro Meetup', location: location, startsAt: '2026-09-20', url: 'https://example.com/meetup' },
        { name: 'Postgres Summit', location: 'San Francisco', startsAt: '2026-11-15', url: 'https://example.com/pg' },
      ];
      if (!q) return all.slice(0, query.limit ?? 10);
      return all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, query.limit ?? 10);
    },
  };

  api.registerEventDiscoveryProvider(provider);

  // Example command
  api.registerCommand('example', 'Run example plugin demo', async (args) => {
    const loc = api.getSetting('default_location') || 'San Francisco';
    return `Example plugin: would discover events near ${loc} with args ${JSON.stringify(args)}`;
  });
}

export default { manifest, register };
