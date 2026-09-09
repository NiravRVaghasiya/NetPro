import Link from "next/link";
import { isOwnerGitHubId } from "@/lib/owner";

// Read-only integration status. The web app is configured server-side via
// environment variables (self-hosted, single-owner deployment); this panel
// reports presence only and never renders secret values.
export const metadata = {
  title: "Settings — NetPro",
};

interface Integration {
  name: string;
  configured: boolean;
  envVars: string[];
  hint: string;
}

function configured(...values: Array<string | undefined>): boolean {
  return values.some((v) => typeof v === "string" && v.trim().length > 0);
}

function integrationsFromEnv(env: NodeJS.ProcessEnv): Integration[] {
  return [
    {
      name: "Instance owner",
      configured: isOwnerGitHubId(
        env.NETPRO_OWNER_GITHUB_ID?.trim(),
        env.NETPRO_OWNER_GITHUB_ID,
      ),
      envVars: ["NETPRO_OWNER_GITHUB_ID"],
      hint: "Required numeric GitHub account ID. All other accounts are denied access (break-glass owner in v3.0).",
    },
    {
      name: "GitHub OAuth (sign-in)",
      configured:
        configured(env.GITHUB_CLIENT_ID) &&
        configured(env.GITHUB_CLIENT_SECRET),
      envVars: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      hint: "OAuth app credentials from github.com/settings/developers.",
    },
    {
      name: "AI outreach — OpenAI",
      configured: configured(env.OPENAI_API_KEY),
      envVars: ["OPENAI_API_KEY", "OPENAI_BASE_URL (optional)"],
      hint: "Used by /outreach for draft generation. OpenAI-compatible endpoints work via OPENAI_BASE_URL.",
    },
    {
      name: "AI outreach — Anthropic",
      configured: configured(env.ANTHROPIC_API_KEY),
      envVars: ["ANTHROPIC_API_KEY", "AI_PROVIDER=anthropic (to prefer it)"],
      hint: "Alternative provider for /outreach draft generation.",
    },
    {
      name: "Enrichment — Hunter.io",
      configured: configured(env.HUNTER_API_KEY),
      envVars: ["HUNTER_API_KEY"],
      hint: "Email finding during contact enrichment.",
    },
    {
      name: "Enrichment — People Data Labs",
      configured: configured(env.PDL_API_KEY),
      envVars: ["PDL_API_KEY"],
      hint: "Profile enrichment (company, role, industry).",
    },
    {
      name: "Enrichment — Clearbit",
      configured: configured(env.CLEARBIT_API_KEY),
      envVars: ["CLEARBIT_API_KEY"],
      hint: "Company/domain enrichment.",
    },
  ];
}

export default function SettingsPage() {
  const integrations = integrationsFromEnv(process.env);

  return (
    <div style={{ maxWidth: 720 }}>
      <h1>Settings</h1>
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">
          Your profile card
        </h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Create a shareable introduction without exposing your contacts.
          Private until you choose to publish.
        </p>
        <Link
          href="/settings/card"
          className="text-sm font-medium text-emerald-800 underline underline-offset-4"
        >
          Edit profile card →
        </Link>
      </section>
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">Team</h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Manage workspace members and invites. v3.0 Phase 1 introduces multi-user workspaces with roles (owner/admin/member/viewer).
        </p>
        <Link
          href="/settings/team"
          className="text-sm font-medium text-emerald-800 underline underline-offset-4"
        >
          Manage team →
        </Link>
      </section>
      <p style={{ color: "#555" }}>
        Integrations are configured with server-side environment variables (BYO
        API keys — NetPro never stores them). Restart the server after changing
        them.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "0.5rem 0.75rem" }}>
              Integration
            </th>
            <th style={{ textAlign: "left", padding: "0.5rem 0.75rem" }}>
              Status
            </th>
            <th style={{ textAlign: "left", padding: "0.5rem 0.75rem" }}>
              Environment variables
            </th>
          </tr>
        </thead>
        <tbody>
          {integrations.map((it) => (
            <tr
              key={it.name}
              style={{ borderTop: "1px solid hsl(var(--border))" }}
            >
              <td style={{ padding: "0.5rem 0.75rem" }}>
                <strong>{it.name}</strong>
                <br />
                <span style={{ color: "#777", fontSize: "0.85rem" }}>
                  {it.hint}
                </span>
              </td>
              <td style={{ padding: "0.5rem 0.75rem" }}>
                {it.configured ? (
                  <span style={{ color: "#15803d" }}>● configured</span>
                ) : (
                  <span style={{ color: "#b45309" }}>○ not set</span>
                )}
              </td>
              <td
                style={{
                  padding: "0.5rem 0.75rem",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                }}
              >
                {it.envVars.map((v) => (
                  <div key={v}>{v}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ color: "#777", fontSize: "0.85rem", marginTop: "1.5rem" }}>
        The CLI manages its keys separately and encrypted on disk — use{" "}
        <code>netpro config set ai.openai.key sk-…</code> there.
      </p>
    </div>
  );
}
