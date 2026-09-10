// v3.0 Phase 6 — marketplace install (admin+). Checksum-verified, manifest
// matched against the index listing, and registered DISABLED: the response
// carries the permissions review, and the enable route's confirm step is
// what turns the plugin on. The principal comes from the session — the body
// supplies only the plugin name.
import { conn } from "@/lib/db";
import { requireMembership } from "@/lib/authz";
import { crmJson, readCrmJson } from "@/lib/crm-request";
import { pluginErrorResponse } from "@/lib/plugins";
import { installPluginFromMarketplace } from "@netpro/core/src/plugins/marketplace";
import { PluginError } from "@netpro/core/src/plugins/manifest";

export async function POST(request: Request): Promise<Response> {
  try {
    const scope = await requireMembership("admin");
    const body = await readCrmJson(request);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) {
      throw new PluginError("invalid_input", "A plugin name is required.");
    }
    const refresh = body.refresh === true;
    const result = await installPluginFromMarketplace(conn, body.name.trim(), { scope, refresh });
    return crmJson(
      {
        plugin: result.plugin,
        review: {
          capabilities: result.plugin.manifest.permissions.capabilities,
          network: result.plugin.manifest.permissions.network ?? [],
          engine: result.plugin.manifest.engine,
        },
      },
      201
    );
  } catch (error: unknown) {
    return pluginErrorResponse(error);
  }
}
