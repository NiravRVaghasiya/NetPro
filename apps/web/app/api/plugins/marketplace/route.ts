// v3.0 Phase 6 — marketplace index reader (admin+). The index fetch is a
// plain server-side GET with a static user agent (no telemetry) plus a local
// cache; `?refresh=1` bypasses the cache and `?q=` filters server-side.
import { requireMembership } from "@/lib/authz";
import { crmJson } from "@/lib/crm-request";
import { pluginErrorResponse } from "@/lib/plugins";
import { fetchMarketplaceIndex, searchMarketplace } from "@netpro/core/src/plugins/marketplace";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireMembership("admin");
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? undefined;
    const refresh = url.searchParams.get("refresh") === "1";
    const { index, indexUrl, fromCache } = await fetchMarketplaceIndex({ refresh });
    return crmJson({
      indexUrl,
      updatedAt: index.updated_at,
      fromCache,
      plugins: searchMarketplace(index, query),
    });
  } catch (error: unknown) {
    return pluginErrorResponse(error);
  }
}
