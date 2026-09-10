// v3.0 Phase 6 — marketplace install-over update (admin+). Monotonic by
// default: identical versions are a no-op and downgrades are refused unless
// the caller passes { force: true }. Enabled state and settings survive.
import { conn } from "@/lib/db";
import { requireMembership } from "@/lib/authz";
import { crmJson, readCrmJson } from "@/lib/crm-request";
import { pluginErrorResponse } from "@/lib/plugins";
import { updatePluginFromMarketplace } from "@netpro/core/src/plugins/marketplace";

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  try {
    const scope = await requireMembership("admin");
    const { name } = await params;
    const body = await readCrmJson(request);
    const force = body.force === true;
    const refresh = body.refresh === true;
    const result = await updatePluginFromMarketplace(conn, name, { scope, force, refresh });
    return crmJson({ updated: result.updated, fromVersion: result.fromVersion, plugin: result.plugin });
  } catch (error: unknown) {
    return pluginErrorResponse(error);
  }
}
