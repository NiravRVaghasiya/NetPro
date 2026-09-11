import Link from "next/link";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import {
  ProviderStatus,
  type ProviderStatusPayload,
} from "@/components/provider-status";

export const metadata = {
  title: "Settings — NetPro",
};

type Installation = {
  id?: string;
  createdAt?: string | null;
  owner?: string | null;
};

export default async function SettingsPage() {
  const serverUrl = getServerUrl();

  // Phase 24 — the installation identity comes from the NetPro server
  // (GET /api/identity), never from reading ~/.netpro in this process.
  let installation: Installation | null = null;
  let identityUnavailable = false;
  try {
    const res = await serverFetchJson<{ installation?: Installation | null }>(
      "/api/identity",
    );
    if (res.ok) installation = res.data.installation ?? null;
    else identityUnavailable = true;
  } catch {
    identityUnavailable = true;
  }

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
        {identityUnavailable || !installation ? (
          <p className="my-2 text-sm leading-6 text-slate-500">
            The installation identity comes from the NetPro server (
            <code>{serverUrl}</code>) — start <code>netpro serve</code> to see
            it here. It is stored in <code>~/.netpro/config.toml</code> (or{" "}
            <code>NETPRO_HOME</code>) and never sent off this machine.
          </p>
        ) : (
          <p className="my-2 text-sm leading-6 text-slate-500">
            Identity <code>{installation.id}</code>
            {installation.owner ? ` · ${installation.owner}` : ""}
            {installation.createdAt
              ? ` · created ${installation.createdAt.slice(0, 10)}`
              : ""}
            . Stored in <code>~/.netpro/config.toml</code> (or{" "}
            <code>NETPRO_HOME</code>) and never sent off this machine.
          </p>
        )}
      </section>

      <section className="my-5">
        {providersUnavailable ? (
          <p className="mb-2 text-xs text-amber-700">
            Provider status comes from the NetPro server (<code>{serverUrl}</code>) — start{" "}
            <code>netpro serve</code> to see it here. NetPro runs either way.
          </p>
        ) : null}
        <ProviderStatus status={providers} title="AI &amp; enrichment providers" />
      </section>

      <p className="my-5 text-sm leading-6 text-slate-500">
        Integrations are configured with server-side environment variables (BYO
        API keys — NetPro never stores them in the browser). Set them on the
        process that runs <code>netpro serve</code> (or the{" "}
        <code>server</code> service in <code>docker-compose.yml</code>) and
        restart it. Optional providers enhance NetPro; without them it still
        runs.
      </p>

      <p className="my-5 text-sm leading-6 text-slate-500">
        The CLI manages its own keys separately and encrypted on disk — use{" "}
        <code>netpro config set ai.openai.key sk-…</code> there.{" "}
        <Link href="/observatory" className="text-emerald-800 underline">
          Back to the Observatory →
        </Link>
      </p>
    </div>
  );
}
