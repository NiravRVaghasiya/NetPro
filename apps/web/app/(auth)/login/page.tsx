import { headers } from "next/headers";
import { signIn } from "@/lib/auth";
import { isGitHubConfigured, isTrustedLocalRequest, resolveWebAuthMode } from "@/lib/auth-mode";
import { resolveInstallationIdentity } from "@/lib/local-owner";
import { isOwnerGitHubId } from "@/lib/owner";

export const metadata = { title: "Sign in — NetPro" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const mode = resolveWebAuthMode();
  const local = await (async () => {
    try {
      return isTrustedLocalRequest(await headers());
    } catch {
      return false;
    }
  })();

  // Phase 5 — GitHub is an option, not a requirement.
  const ownerConfigured = isOwnerGitHubId(process.env.NETPRO_OWNER_GITHUB_ID?.trim());
  const configured = isGitHubConfigured() && ownerConfigured;

  const identity =
    mode === "local" && local ? resolveInstallationIdentity().identity : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f3f5ef] px-6">
      <div className="w-full max-w-md rounded-2xl border border-[#dce3dc] bg-white p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#567164]">
          {mode === "github" ? "NetPro · Owner access" : "NetPro"}
        </p>
        <h1 className="mb-3 mt-5 text-2xl font-semibold tracking-tight text-[#183c30]">
          Your network stays yours.
        </h1>

        {mode === "github" ? (
          <>
            <p className="text-sm leading-6 text-slate-500">
              This NetPro instance signs callers in with GitHub.
            </p>
            {error && (
              <p
                role="alert"
                className="mt-5 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900"
              >
                {error === "AccessDenied"
                  ? "That GitHub account isn’t authorized for this instance. Use the configured owner account."
                  : "Sign-in could not be completed. Check the server’s OAuth configuration and try again."}
              </p>
            )}
            {!configured ? (
              <div className="mt-5 rounded-lg bg-slate-50 p-4 text-xs leading-6 text-slate-600">
                <p className="font-semibold">GitHub sign-in needs configuration.</p>
                <p>
                  Set <code>GITHUB_CLIENT_ID</code>,{" "}
                  <code>GITHUB_CLIENT_SECRET</code>
                  {!ownerConfigured && (
                    <>
                      , and <code>NETPRO_OWNER_GITHUB_ID</code>
                    </>
                  )}{" "}
                  in the server environment, then restart. To run without GitHub
                  instead, unset <code>NETPRO_AUTH_MODE</code> — local NetPro
                  needs no credentials at all. See <code>docs/getting-started.md</code>.
                </p>
              </div>
            ) : (
              <form
                action={async () => {
                  "use server";
                  await signIn("github", { redirectTo: "/dashboard" });
                }}
              >
                <button
                  type="submit"
                  className="mt-6 w-full rounded-lg bg-[#214e3b] px-5 py-3 text-sm font-medium text-white hover:bg-[#183c30]"
                >
                  Continue with GitHub
                </button>
              </form>
            )}
          </>
        ) : mode === "open" ? (
          <>
            <p className="text-sm leading-6 text-slate-500">
              This instance runs in <strong>open mode</strong>: NetPro
              authenticates nobody, so it must sit behind something that does —
              a reverse proxy with its own sign-in, a VPN, or a private
              network. Requests are treated as the installation owner.
            </p>
            <a
              href="/dashboard"
              className="mt-6 block w-full rounded-lg bg-[#214e3b] px-5 py-3 text-center text-sm font-medium text-white hover:bg-[#183c30]"
            >
              Continue to the dashboard
            </a>
          </>
        ) : local ? (
          <>
            <p className="text-sm leading-6 text-slate-500">
              NetPro is running locally. You are the operator on this machine,
              so there is nothing to sign in to.
            </p>
            <a
              href="/dashboard"
              className="mt-6 block w-full rounded-lg bg-[#214e3b] px-5 py-3 text-center text-sm font-medium text-white hover:bg-[#183c30]"
            >
              Continue to the dashboard
            </a>
            {identity && (
              <p className="mt-4 text-xs leading-6 text-slate-500">
                Installation <code>{identity.id}</code>
                {identity.owner ? ` · ${identity.owner}` : ""} — recorded in{" "}
                <code>~/.netpro/config.toml</code>.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-slate-500">
              This NetPro instance is <strong>local-only</strong>. It trusts the
              operator at the machine it runs on, and nothing else — so this
              browser cannot open the private workspace while GitHub sign-in is
              unconfigured.
            </p>
            <div className="mt-5 rounded-lg bg-slate-50 p-4 text-xs leading-6 text-slate-600">
              <p className="font-semibold">To use NetPro from this machine</p>
              <p>
                Open <code>http://127.0.0.1:3000</code> (or run{" "}
                <code>netpro serve</code> and use the local server).
              </p>
              <p className="mt-3 font-semibold">To use it from somewhere else</p>
              <p>
                Set <code>NETPRO_AUTH_MODE=github</code> with{" "}
                <code>GITHUB_CLIENT_ID</code>,{" "}
                <code>GITHUB_CLIENT_SECRET</code>, and{" "}
                <code>NETPRO_OWNER_GITHUB_ID</code>, or{" "}
                <code>NETPRO_AUTH_MODE=open</code> when a reverse proxy or VPN
                already authenticates callers. See{" "}
                <code>docs/deployment.md</code>.
              </p>
            </div>
          </>
        )}

        {mode !== "github" && configured && (
          <p className="mt-5 text-xs leading-6 text-slate-500">
            GitHub sign-in is configured and available to remote callers.
          </p>
        )}

        <a
          href="/card"
          className="mt-6 inline-block text-xs text-[#567164] underline underline-offset-4"
        >
          Looking for the public profile card?
        </a>
      </div>
    </main>
  );
}
