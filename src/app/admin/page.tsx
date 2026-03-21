'use client';

import { useState, useEffect } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';
import { cn } from '@/lib/utils';

type Tab = 'users' | 'invitations' | 'activity';

interface UserInfo {
  id: string;
  email: string;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
  portfolioCount: number;
  sessionCount: number;
}

interface InviteInfo {
  id: string;
  code: string;
  email: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  usedBy: { email: string } | null;
}

interface ActivityUser {
  email: string;
  totalSessions: number;
  avgDurationSec: number;
  lastActive: string | null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [activity, setActivity] = useState<{ totalUsers: number; activeToday: number; avgSessionDurationSec: number; perUser: ActivityUser[] } | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [tab]);

  const fetchData = async () => {
    setLoading(true);
    try {
      if (tab === 'users') {
        const res = await fetch('/api/admin/users');
        const json = await res.json();
        if (json.success) setUsers(json.data);
      } else if (tab === 'invitations') {
        const res = await fetch('/api/admin/invites');
        const json = await res.json();
        if (json.success) setInvites(json.data);
      } else {
        const res = await fetch('/api/admin/activity');
        const json = await res.json();
        if (json.success) setActivity(json.data);
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  const resetPassword = async (userId: string) => {
    if (!confirm('Reset this user\'s password? They will receive a temporary password via email.')) return;
    setActionLoading(userId);
    try {
      await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      alert('Password reset email sent.');
    } catch { alert('Failed to reset password.'); }
    finally { setActionLoading(null); }
  };

  const removeUser = async (userId: string, email: string) => {
    if (!confirm(`Permanently remove ${email} and all their portfolios?`)) return;
    setActionLoading(userId);
    try {
      await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      fetchData();
    } catch { alert('Failed to remove user.'); }
    finally { setActionLoading(null); }
  };

  const sendInvite = async () => {
    if (!inviteEmail || !inviteEmail.includes('@')) return;
    setActionLoading('invite');
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail }),
      });
      const json = await res.json();
      if (json.success) {
        setInviteEmail('');
        fetchData();
      } else {
        alert(json.error || 'Failed to send invite.');
      }
    } catch { alert('Failed to send invite.'); }
    finally { setActionLoading(null); }
  };

  const revokeInvite = async (invitationId: string) => {
    if (!confirm('Revoke this invitation?')) return;
    setActionLoading(invitationId);
    try {
      await fetch('/api/admin/invites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationId }),
      });
      fetchData();
    } catch { alert('Failed to revoke.'); }
    finally { setActionLoading(null); }
  };

  const statusColor = (status: string) => {
    if (status === 'pending') return 'bg-spike-amber/10 text-spike-amber';
    if (status === 'accepted') return 'bg-spike-green/10 text-spike-green';
    return 'bg-spike-red/10 text-spike-red';
  };

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />
      <Sidebar />
      <main className="ml-64 p-8 relative z-10">
        <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
          ADMIN PANEL
        </h2>

        {/* Tabs */}
        <div className="flex gap-1 bg-spike-bg/50 rounded-lg border border-spike-border p-0.5 mb-6 w-fit">
          {(['users', 'invitations', 'activity'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-4 py-2 rounded-md text-sm font-medium transition-all capitalize',
                tab === t ? 'bg-spike-cyan/10 text-spike-cyan' : 'text-spike-text-dim hover:text-spike-text'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Users Tab */}
        {tab === 'users' && (
          <div className="glass-card p-6">
            <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Registered Users</h3>
            {loading ? (
              <p className="text-spike-text-muted">Loading...</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                    <th className="text-left py-3 px-2">Email</th>
                    <th className="text-left py-3 px-2">Role</th>
                    <th className="text-left py-3 px-2">Last Login</th>
                    <th className="text-center py-3 px-2">Portfolios</th>
                    <th className="text-center py-3 px-2">Sessions</th>
                    <th className="text-left py-3 px-2">Created</th>
                    <th className="text-right py-3 px-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-spike-border/50 hover:bg-spike-bg-hover/30">
                      <td className="py-3 px-2 text-spike-text">{u.email}</td>
                      <td className="py-3 px-2">
                        <span className={cn('px-2 py-0.5 rounded text-xs font-medium', u.role === 'admin' ? 'bg-spike-cyan/10 text-spike-cyan' : 'bg-spike-border text-spike-text-dim')}>
                          {u.role}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-spike-text-dim">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('en-CA') : 'Never'}
                      </td>
                      <td className="py-3 px-2 text-center text-spike-text-dim">{u.portfolioCount}</td>
                      <td className="py-3 px-2 text-center text-spike-text-dim">{u.sessionCount}</td>
                      <td className="py-3 px-2 text-spike-text-dim">
                        {new Date(u.createdAt).toLocaleDateString('en-CA')}
                      </td>
                      <td className="py-3 px-2 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => resetPassword(u.id)}
                            disabled={actionLoading === u.id}
                            className="px-2 py-1 text-xs rounded bg-spike-amber/10 text-spike-amber hover:bg-spike-amber/20 transition-all disabled:opacity-50"
                          >
                            Reset PW
                          </button>
                          {u.role !== 'admin' && (
                            <button
                              onClick={() => removeUser(u.id, u.email)}
                              disabled={actionLoading === u.id}
                              className="px-2 py-1 text-xs rounded bg-spike-red/10 text-spike-red hover:bg-spike-red/20 transition-all disabled:opacity-50"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Invitations Tab */}
        {tab === 'invitations' && (
          <div className="space-y-6">
            <div className="glass-card p-6">
              <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Send Invitation</h3>
              <div className="flex gap-3">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="flex-1 bg-spike-bg border border-spike-border rounded-lg px-4 py-2 text-sm text-spike-text focus:outline-none focus:border-spike-cyan/50"
                />
                <button
                  onClick={sendInvite}
                  disabled={!inviteEmail || actionLoading === 'invite'}
                  className="px-6 py-2 rounded-lg bg-gradient-to-r from-spike-cyan to-spike-violet text-spike-bg font-bold text-sm hover:opacity-90 transition-all disabled:opacity-50"
                >
                  {actionLoading === 'invite' ? 'Sending...' : 'Send Invite'}
                </button>
              </div>
            </div>

            <div className="glass-card p-6">
              <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">All Invitations</h3>
              {loading ? (
                <p className="text-spike-text-muted">Loading...</p>
              ) : invites.length === 0 ? (
                <p className="text-spike-text-muted text-sm">No invitations sent yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                      <th className="text-left py-3 px-2">Email</th>
                      <th className="text-left py-3 px-2">Code</th>
                      <th className="text-left py-3 px-2">Status</th>
                      <th className="text-left py-3 px-2">Sent</th>
                      <th className="text-left py-3 px-2">Expires</th>
                      <th className="text-right py-3 px-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => (
                      <tr key={inv.id} className="border-b border-spike-border/50">
                        <td className="py-3 px-2 text-spike-text">{inv.email}</td>
                        <td className="py-3 px-2 text-spike-text-dim mono text-xs">
                          {inv.status === 'pending' ? inv.code : `${inv.code.slice(0, 5)}***`}
                        </td>
                        <td className="py-3 px-2">
                          <span className={cn('px-2 py-0.5 rounded text-xs font-medium', statusColor(inv.status))}>
                            {inv.status}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-spike-text-dim">
                          {new Date(inv.createdAt).toLocaleDateString('en-CA')}
                        </td>
                        <td className="py-3 px-2 text-spike-text-dim">
                          {new Date(inv.expiresAt).toLocaleDateString('en-CA')}
                        </td>
                        <td className="py-3 px-2 text-right">
                          {inv.status === 'pending' && (
                            <button
                              onClick={() => revokeInvite(inv.id)}
                              disabled={actionLoading === inv.id}
                              className="px-2 py-1 text-xs rounded bg-spike-red/10 text-spike-red hover:bg-spike-red/20 transition-all disabled:opacity-50"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Activity Tab */}
        {tab === 'activity' && (
          <div className="space-y-6">
            {activity && (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Total Users</p>
                    <p className="text-xl font-bold text-spike-cyan mono">{activity.totalUsers}</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Active Today</p>
                    <p className="text-xl font-bold text-spike-green mono">{activity.activeToday}</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Avg Session</p>
                    <p className="text-xl font-bold text-spike-violet mono">{formatDuration(activity.avgSessionDurationSec)}</p>
                  </div>
                </div>

                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Per-User Activity</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                        <th className="text-left py-3 px-2">Email</th>
                        <th className="text-center py-3 px-2">Sessions</th>
                        <th className="text-center py-3 px-2">Avg Duration</th>
                        <th className="text-left py-3 px-2">Last Active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.perUser.map((u) => (
                        <tr key={u.email} className="border-b border-spike-border/50">
                          <td className="py-3 px-2 text-spike-text">{u.email}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim">{u.totalSessions}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim">{formatDuration(u.avgDurationSec)}</td>
                          <td className="py-3 px-2 text-spike-text-dim">
                            {u.lastActive ? new Date(u.lastActive).toLocaleDateString('en-CA') : 'Never'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {loading && <p className="text-spike-text-muted">Loading...</p>}
          </div>
        )}

        <div className="legal-footer">
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 2.0</p>
        </div>
      </main>
    </div>
  );
}
