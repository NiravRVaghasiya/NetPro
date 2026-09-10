// v3.0 Phase 5 — plugins settings page (admin+).

import { conn } from '@/lib/db';
import { requireMembership } from '@/lib/authz';
import { listPlugins } from '@netpro/core/src/plugins/repository';
import PluginsClient from './client';

export const metadata = {
  title: 'Plugins — NetPro',
};
export const dynamic = 'force-dynamic';

export default async function PluginsPage() {
  const scope = await requireMembership('admin');

  const plugins = await listPlugins(conn, scope);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-2">Plugins</h1>
      <p className="text-sm text-slate-500 mb-2">
        Plugins run in-process with Node privileges. The permission manifest enforces the network boundary and scopes the data boundary, but a malicious plugin is defended only by operator review — nothing is auto-installed. Review permissions before enabling.
      </p>
      <p className="text-xs text-slate-400 mb-6">
        Trust model: operator-trusted in-process code. Network hosts are allowlisted; data API is workspace-scoped. Marketplace (Phase 6) will show permissions before install.
      </p>
      <PluginsClient initialPlugins={plugins} workspaceId={scope.workspaceId} role={scope.role} />
    </div>
  );
}
