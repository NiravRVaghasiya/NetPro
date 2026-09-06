// Database-free and safe for the middleware bundle. A NetPro v1 instance is
// single-owner: contacts are not partitioned by user, so open registration is unsafe.
export function isOwnerGitHubId(
  id: unknown,
  configuredId = process.env.NETPRO_OWNER_GITHUB_ID,
): boolean {
  const owner = configuredId?.trim() ?? "";
  return /^[1-9]\d*$/.test(owner) && typeof id === "string" && id === owner;
}
