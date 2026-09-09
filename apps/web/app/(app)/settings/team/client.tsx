'use client';

import { useState } from 'react';

interface Member {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string; image: string | null } | null;
}

interface Invite {
  id: string;
  workspaceId: string;
  token: string;
  role: string;
  expiresAt: string;
  createdBy: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Props {
  workspaceId: string;
  currentUserId: string;
  currentRole: string;
  members: Member[];
  invites: Invite[];
}

export default function TeamClient({ workspaceId, currentUserId, currentRole, members: initialMembers, invites: initialInvites }: Props) {
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [newRole, setNewRole] = useState('member');
  const [creating, setCreating] = useState(false);
  const [lastInvite, setLastInvite] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createInvite() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create invite');
      } else {
        setLastInvite({ token: data.token, url: data.url });
        setInvites((prev) => [...prev, data.invite]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvite(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/invites/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to revoke');
      } else {
        setInvites((prev) => prev.map((inv) => (inv.id === id ? { ...inv, revokedAt: new Date().toISOString() } : inv)));
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function changeRole(userId: string, role: string) {
    setError(null);
    try {
      const res = await fetch('/api/workspaces/members', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to change role');
      } else {
        setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: data.member.role } : m)));
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function removeMember(userId: string) {
    if (!confirm(`Remove member ${userId}?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to remove');
      } else {
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="space-y-8">
      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded">{error}</div>}
      {lastInvite && (
        <div className="p-4 bg-green-50 border border-green-200 rounded">
          <p className="font-medium">Invite created!</p>
          <p className="text-sm break-all">Link: {window.location.origin}{lastInvite.url}</p>
          <p className="text-xs text-gray-500 mt-1">Share this link securely. It expires in 7 days and is single-use.</p>
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Members ({members.length})</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">User</th>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Role</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b">
                <td className="p-2">{m.user?.name || m.userId.slice(0, 8)}</td>
                <td className="p-2">{m.user?.email || '—'}</td>
                <td className="p-2">
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.userId, e.target.value)}
                    disabled={currentRole !== 'owner' && currentRole !== 'admin'}
                    className="border rounded px-2 py-1"
                  >
                    <option value="viewer">viewer</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                </td>
                <td className="p-2">
                  <button
                    onClick={() => removeMember(m.userId)}
                    disabled={m.userId === currentUserId}
                    className="text-red-600 underline disabled:opacity-30"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Invites</h2>
        <div className="flex gap-2 mb-4">
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="border rounded px-2 py-1">
            <option value="viewer">viewer</option>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button
            onClick={createInvite}
            disabled={creating}
            className="px-3 py-1 bg-black text-white rounded disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create invite'}
          </button>
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">Role</th>
              <th className="text-left p-2">Expires</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => (
              <tr key={inv.id} className="border-b">
                <td className="p-2">{inv.role}</td>
                <td className="p-2">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                <td className="p-2">
                  {inv.revokedAt ? 'revoked' : inv.acceptedAt ? 'accepted' : 'pending'}
                </td>
                <td className="p-2">
                  {!inv.revokedAt && !inv.acceptedAt && (
                    <button onClick={() => revokeInvite(inv.id)} className="text-red-600 underline">
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
