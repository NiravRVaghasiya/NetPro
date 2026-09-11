import Link from "next/link";
import { isGitHubConfigured, resolveWebAuthMode } from "@/lib/auth-mode";
import { resolveInstallationIdentity } from "@/lib/local-owner";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import {
  ProviderStatus,
  type ProviderStatusPayload,
} from "@/components/provider-status";

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
  const authMode = resolveWebAuthMode(env);
  return [
    {
      name: "Sign-in",
      configured: true,
      envVars: ["NETPRO_AUTH_MODE"],
      hint:
        authMode === "github"
          ? "GitHub OAuth — every caller signs in with GitHub."
          : authMode === "open"
            ? "Open — NetPro authenticates nobody; a reverse proxy or private network must."
            : "Local — the operator on this machine is trusted; every other caller needs GitHub sign-in or their own front door.",
    },
    {
      name: "Installation identity",
      configured: true,
      envVars: ["~/.netpro/config.toml (or NETPRO_HOME)"],
      hint: "Created by `netpro init` on first run; identifies this installation to the local server and the CLI.",
    },
    {
      name: "GitHub OAuth (optional integration)",
      configured: isGitHubConfigured(env),
      envVars: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      hint: "Optional. Needed only for remote sign-in; local NetPro never asks for it. OAuth app credentials from github.com/settings/developers.",
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

export default async function SettingsPage() {
  const integrations = integrationsFromEnv(process.env);
  const installation = resolveInstallationIdentity().identity;

  // Phase 17 — provider status comes from the NetPro server, which reads the
  // same @netpro/core registry as the CLI (`netpro status`). The Web UI never
  // inspects provider keys itself.
  let providers: ProviderStatusPayload | null = null;
  let providersUnavailable = false;
  try {
    const res = await serverFetchJson<ProviderStatusPayload>("/api/providers");
    if (res.ok) providers = res.data;
    else providersUnavailable = true;
  } catch {
    providersUnavailable = true;
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1>Settings</h1>
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">
          This installation
        </h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Identity <code>{installation.id}</code>
          {installation.owner ? ` · ${installation.owner}` : ""}
          {installation.createdAt
            ? ` · created ${installation.createdAt.slice(0, 10)}`
            : ""}
          . Stored in <code>~/.netpro/config.toml</code> (or{" "}
          <code>NETPRO_HOME</code>) and never sent off this machine.
        </p>
      </section>
      <section className="my-5">
        {providersUnavailable ? (
          <p className="mb-2 text-xs text-amber-700">
            Provider status comes from the NetPro server (<code>{getServerUrl()}</code>) — start{" "}
            <code>netpro serve</code> to see it here. NetPro runs either way; the table below reads
            this process&apos;s own environment as a fallback.
          </p>
        ) : null}
        <ProviderStatus status={providers} title="AI &amp; enrichment providers" />
      </section>

      <p className="my-5"><Link href="/settings/keys" className="text-emerald-800 underline">Manage encrypted provider keys →</Link></p>
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
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">Activity log</h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Audit trail of workspace actions — CRM, invites, campaigns, member changes. Admin+ only, filterable.
        </p>
        <Link
          href="/settings/activity"
          className="text-sm font-medium text-emerald-800 underline underline-offset-4"
        >
          View activity →
        </Link>
      </section>
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">Plugins</h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Extend NetPro with custom data sources, enrichers, AI providers, content providers, event discovery, and commands. v3.0 Phase 5 — permission manifest, workspace-scoped, no auto-install.
        </p>
        <Link
          href="/settings/plugins"
          className="text-sm font-medium text-emerald-800 underline underline-offset-4"
        >
          Manage plugins →
        </Link>
      </section>
      <section className="my-5 rounded-xl border border-slate-200 p-5">
        <h2 className="text-base font-semibold text-[#183c30]">Webhooks</h2>
        <p className="my-2 text-sm leading-6 text-slate-500">
          Outbound webhooks push workspace events to Zapier, n8n, Make, or any URL. Signed with HMAC-SHA256, retried with backoff, 30-day delivery log. v3.0 Phase 7.
        </p>
        <Link
          href="/settings/webhooks"
          className="text-sm font-medium text-emerald-800 underline underline-offset-4"
        >
          Manage webhooks →
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
