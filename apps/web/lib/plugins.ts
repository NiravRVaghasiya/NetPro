import { PluginError } from "@netpro/core/src/plugins/manifest";
import { CrmRequestError, crmJson } from "./crm-request";

/**
 * Map PluginError codes to HTTP statuses. Local validation failures are 4xx;
 * remote-index and supply-chain failures (fetch, checksum, manifest drift,
 * oversized payloads, git sources) are 502: the upstream index or archive is
 * at fault, not the request. Messages are user-facing by construction.
 */
const STATUS_BY_CODE: Record<PluginError["code"], number> = {
  invalid_manifest: 400,
  invalid_input: 400,
  engine_mismatch: 400,
  downgrade_refused: 409,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  invalid_index: 502,
  fetch_failed: 502,
  too_large: 502,
  checksum_mismatch: 502,
  manifest_mismatch: 502,
  git_source_failed: 502,
  unsupported_scheme: 502,
};

export function pluginErrorResponse(error: unknown): Response {
  if (error instanceof CrmRequestError) {
    return crmJson({ error: error.message }, error.status);
  }
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401 || status === 403) {
      return crmJson({ error: error.message }, status);
    }
  }
  if (error instanceof PluginError) {
    return crmJson({ error: error.message, code: error.code }, STATUS_BY_CODE[error.code]);
  }
  return crmJson({ error: "Unable to process the request. Please try again." }, 500);
}
