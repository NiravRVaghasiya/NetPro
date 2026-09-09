'use client';

import { useState } from 'react';

interface Props {
  token: string;
  status: string;
  inviteInfo: { workspaceId: string; role: string; expiresAt: string } | null;
  errorMessage: string | null;
}

export default function InviteClient({ token, status, inviteInfo, errorMessage }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(errorMessage);

  async function accept() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept invite');
      } else {
        setResult('Invite accepted! Redirecting to dashboard...');
        setTimeout(() => {
          window.location.href = '/dashboard';
        }, 1000);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (status === 'already-member') {
    return (
      <div className="space-y-4">
        <p className="text-green-600">You are already a member.</p>
        <a href="/dashboard" className="text-blue-600 underline">
          Go to dashboard
        </a>
      </div>
    );
  }

  if (status !== 'valid') {
    return (
      <div className="space-y-4">
        <p className="text-red-600">{error || 'Invalid invite.'}</p>
        <p className="text-sm text-gray-500">Ask an admin for a new invite link.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {inviteInfo && (
        <div className="border rounded p-4 bg-gray-50">
          <p>
            <strong>Workspace:</strong> {inviteInfo.workspaceId}
          </p>
          <p>
            <strong>Role:</strong> {inviteInfo.role}
          </p>
          <p>
            <strong>Expires:</strong> {new Date(inviteInfo.expiresAt).toLocaleString()}
          </p>
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
      {result && <p className="text-green-600">{result}</p>}
      <button
        onClick={accept}
        disabled={loading}
        className="px-4 py-2 bg-black text-white rounded disabled:opacity-50"
      >
        {loading ? 'Accepting...' : 'Accept invite'}
      </button>
    </div>
  );
}
