// apps/web/components/provider-status.tsx
//
// Phase 17 — Optional AI and Enrichment.
//
// The Web UI must "clearly show provider status":
//
//   AI           ● Not configured
//   Enrichment   ● Hunter configured
//   Embeddings   ● Disabled
//
// This component renders exactly that, straight from the server's
// `GET /api/providers` snapshot (which is @netpro/core's provider registry,
// serialized). It computes nothing about providers itself — no env reads, no
// key handling, no business logic — and it never receives a key: the endpoint
// only ever emits booleans and where a key came from.
//
// It is a pure server component (no hooks), so it renders identically in
// tests, in RSC, and before any JS hydrates.

export type ProviderStatusProvider = {
  id: string;
  label: string;
  configured: boolean;
  source?: "env" | "keychain" | "none";
  purpose?: string;
  envVars?: readonly string[] | string[];
};

export type ProviderStatusCategory = {
  id: string;
  label: string;
  configured: boolean;
  status?: "configured" | "not configured" | "disabled";
  detail?: string;
  configuredProviders?: string[];
  providers?: ProviderStatusProvider[];
};

export type DegradedCapability = {
  capability: string;
  label: string;
  reason: string;
  enable: string;
};

export type ProviderStatusPayload = {
  categories?: ProviderStatusCategory[];
  capabilities?: Record<string, string>;
  degraded?: DegradedCapability[];
  warnings?: string[];
  runsWithoutProviders?: boolean;
};

const CARD: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "1rem 1.1rem",
  background: "white",
};

/** The plan's three strips — the categories the UI always surfaces first. */
const PRIMARY_CATEGORIES = ["ai", "enrichment", "embeddings"];

function dotColor(configured: boolean): string {
  return configured ? "#16a34a" : "#9ca3af";
}

function Row({ category }: { category: ProviderStatusCategory }) {
  const configured = Boolean(category.configured);
  const detail = category.detail ?? (configured ? "Configured" : "Not configured");
  const width = 11;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "0.5rem",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "0.85rem",
        color: "#374151",
      }}
    >
      <span style={{ display: "inline-block", minWidth: width * 8 }}>{category.label}</span>
      <span aria-hidden style={{ color: dotColor(configured), fontSize: "1rem", lineHeight: 1 }}>
        ●
      </span>
      <span style={{ color: configured ? "#15803d" : "#6b7280" }}>{detail}</span>
    </div>
  );
}

/**
 * Provider status, as the plan draws it.
 *
 * `status` is the server snapshot; when the server is unreachable it is null
 * and the component says so instead of guessing from `process.env` — the Web
 * UI is a client of the server, not a second source of truth.
 */
export function ProviderStatus({
  status,
  title = "Providers",
  showDetails = true,
}: {
  status: ProviderStatusPayload | null;
  title?: string;
  showDetails?: boolean;
}) {
  if (!status || !Array.isArray(status.categories) || status.categories.length === 0) {
    return (
      <div style={CARD}>
        <h2 style={{ margin: 0, fontSize: "1rem", color: "#183c30" }}>{title}</h2>
        <p style={{ color: "#92400e", fontSize: "0.86rem", marginTop: "0.4rem", marginBottom: 0 }}>
          Provider status is unavailable — start the NetPro server (<code>netpro serve</code>) to see
          which AI and enrichment providers are configured. NetPro itself runs either way.
        </p>
      </div>
    );
  }

  const categories = [...status.categories].sort((a, b) => {
    const ai = PRIMARY_CATEGORIES.indexOf(a.id);
    const bi = PRIMARY_CATEGORIES.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const degraded = status.degraded ?? [];
  const warnings = status.warnings ?? [];

  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: "1rem", color: "#183c30" }}>{title}</h2>
        <span style={{ fontSize: "0.78rem", color: "#6b7280" }}>
          all optional — NetPro runs without them
        </span>
      </div>

      <div style={{ marginTop: "0.7rem", display: "grid", gap: "0.3rem" }}>
        {categories.map((category) => (
          <Row key={category.id} category={category} />
        ))}
      </div>

      {showDetails ? (
        <div style={{ marginTop: "0.85rem", borderTop: "1px solid #f3f4f6", paddingTop: "0.7rem" }}>
          {categories.map((category) => (
            <div key={category.id} style={{ marginBottom: "0.6rem" }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#374151" }}>
                {category.label}
              </div>
              {(category.providers ?? []).map((provider) => (
                <div
                  key={provider.id}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    fontSize: "0.78rem",
                    color: "#6b7280",
                    marginTop: "0.15rem",
                  }}
                >
                  <span style={{ minWidth: 130 }}>
                    {provider.configured ? "●" : "○"} {provider.label}
                  </span>
                  <span>
                    {provider.configured
                      ? `configured (${provider.source ?? "env"})`
                      : "not set"}
                    {provider.purpose ? ` — ${provider.purpose}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {degraded.length > 0 ? (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#374151" }}>
            Off right now (NetPro stays fully usable)
          </div>
          {degraded.map((item) => (
            <div key={item.capability} style={{ fontSize: "0.78rem", color: "#6b7280", marginTop: "0.25rem" }}>
              • <strong style={{ color: "#374151" }}>{item.label}</strong> — {item.reason}
              <div style={{ color: "#9ca3af" }}>Enable: {item.enable}</div>
            </div>
          ))}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div style={{ marginTop: "0.6rem" }}>
          {warnings.map((warning) => (
            <div
              key={warning}
              style={{ fontSize: "0.78rem", color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "0.35rem 0.6rem" }}
            >
              {warning}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
