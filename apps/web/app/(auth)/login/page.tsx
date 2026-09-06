import { signIn } from "@/lib/auth";
import { isOwnerGitHubId } from "@/lib/owner";

export const metadata = { title: "Owner sign-in — NetPro" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured =
    Boolean(
      process.env.GITHUB_CLIENT_ID?.trim() &&
      process.env.GITHUB_CLIENT_SECRET?.trim(),
    ) && isOwnerGitHubId(process.env.NETPRO_OWNER_GITHUB_ID?.trim());
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f3f5ef] px-6">
      <div className="w-full max-w-md rounded-2xl border border-[#dce3dc] bg-white p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#567164]">
          NetPro · Owner access
        </p>
        <h1 className="mb-3 mt-5 text-2xl font-semibold tracking-tight text-[#183c30]">
          Your network stays yours.
        </h1>
        <p className="text-sm leading-6 text-slate-500">
          This is a single-owner NetPro instance. Only its configured GitHub
          account can access the private workspace.
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
            <p className="font-semibold">Owner sign-in needs configuration.</p>
            <p>
              Set <code>GITHUB_CLIENT_ID</code>,{" "}
              <code>GITHUB_CLIENT_SECRET</code>, and{" "}
              <code>NETPRO_OWNER_GITHUB_ID</code> in the server environment,
              then restart. See <code>docs/getting-started.md</code>.
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
