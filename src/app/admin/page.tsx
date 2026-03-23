'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn } from '@/lib/utils';

type Tab = 'users' | 'invitations' | 'activity' | 'council';

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

interface CouncilStatus {
  councilHealth: { status?: string; council_running?: boolean; last_run_time?: number; last_run_error?: string };
  runInProgress: boolean;
  lastTriggerResult: { success: boolean; error?: string; startedAt?: string; completedAt?: string; spikeCount?: number } | null;
  latestLog: { date: string; processingTimeMs: number | null; consensusScore: number | null } | null;
  recentReports: { id: string; date: string; generatedAt: string; regime: string | null; spikeCount: number }[];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatDurationMs(ms: number): string {
  return formatDuration(Math.round(ms / 1000));
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [activity, setActivity] = useState<{ totalUsers: number; activeToday: number; avgSessionDurationSec: number; perUser: ActivityUser[] } | null>(null);
  const [council, setCouncil] = useState<CouncilStatus | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchData();
  }, [tab]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

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
      } else if (tab === 'activity') {
        const res = await fetch('/api/admin/activity');
        const json = await res.json();
        if (json.success) setActivity(json.data);
      } else if (tab === 'council') {
        await fetchCouncilStatus();
      }
    } catch { /* handle */ }
    finally { setLoading(false); }
  };

  const fetchCouncilStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/council');
      const json = await res.json();
      if (json.success) {
        setCouncil(json.data);
        // If running, ensure polling is active
        if (json.data.runInProgress && !pollRef.current) {
          startPolling();
        }
        // If no longer running, stop polling
        if (!json.data.runInProgress && pollRef.current) {
          stopPolling();
        }
      }
    } catch { /* silent */ }
  }, []);

  const startPolling = () => {
    if (pollRef.current) return;
    const startTime = Date.now();
    setElapsedTime(0);
    // Elapsed timer — tick every second
    timerRef.current = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    // Status poll — every 30 seconds
    pollRef.current = setInterval(() => {
      fetchCouncilStatus();
    }, 30000);
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const triggerCouncilRun = async () => {
    setShowConfirm(false);
    setActionLoading('council');
    try {
      const res = await fetch('/api/admin/council', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        startPolling();
        await fetchCouncilStatus();
      } else {
        alert(json.error || 'Failed to start council run.');
      }
    } catch {
      alert('Failed to trigger council run.');
    } finally {
      setActionLoading(null);
    }
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

  const regimeColor = (regime: string | null) => {
    if (regime === 'bull') return 'text-spike-green';
    if (regime === 'bear') return 'text-spike-red';
    return 'text-spike-amber';
  };

  const isRunning = council?.runInProgress || false;

  return (
    <ResponsiveLayout>
        <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
          ADMIN PANEL
        </h2>

        {/* Tabs */}
        <div className="flex gap-1 bg-spike-bg/50 rounded-lg border border-spike-border p-0.5 mb-6 w-fit">
          {(['users', 'invitations', 'activity', 'council'] as const).map((t) => (
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
              <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[600px]">
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
              </div>
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
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
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
                </div>
              )}
            </div>
          </div>
        )}

        {/* Activity Tab */}
        {tab === 'activity' && (
          <div className="space-y-6">
            {activity && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
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
                </div>
              </>
            )}
            {loading && <p className="text-spike-text-muted">Loading...</p>}
          </div>
        )}

        {/* Council Tab */}
        {tab === 'council' && (
          <div className="space-y-6">
            {/* Status Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Status</p>
                {isRunning ? (
                  <div className="flex items-center justify-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-spike-amber animate-pulse" />
                    <p className="text-xl font-bold text-spike-amber mono">Running</p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-spike-green" />
                    <p className="text-xl font-bold text-spike-green mono">Idle</p>
                  </div>
                )}
              </div>
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Last Run</p>
                <p className="text-xl font-bold text-spike-cyan mono">
                  {council?.latestLog?.processingTimeMs
                    ? formatDurationMs(council.latestLog.processingTimeMs)
                    : council?.councilHealth?.last_run_time
                      ? formatDuration(Math.round(council.councilHealth.last_run_time))
                      : '--'}
                </p>
              </div>
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Python Server</p>
                <p className={cn('text-xl font-bold mono', council?.councilHealth?.status === 'ok' ? 'text-spike-green' : 'text-spike-red')}>
                  {council?.councilHealth?.status === 'ok' ? 'Online' : 'Offline'}
                </p>
              </div>
            </div>

            {/* Running indicator with elapsed time */}
            {isRunning && (
              <div className="glass-card p-4 border border-spike-amber/30">
                <div className="flex items-center gap-3">
                  <span className="inline-block w-3 h-3 rounded-full bg-spike-amber animate-pulse" />
                  <div>
                    <p className="text-spike-amber font-bold text-sm">Council scan in progress...</p>
                    <p className="text-spike-text-dim text-xs">
                      Elapsed: {formatDuration(elapsedTime)} — Polling every 30s for updates
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Last trigger result */}
            {council?.lastTriggerResult?.completedAt && (
              <div className={cn(
                'glass-card p-4 border',
                council.lastTriggerResult.success ? 'border-spike-green/30' : 'border-spike-red/30'
              )}>
                <p className={cn('text-sm font-bold', council.lastTriggerResult.success ? 'text-spike-green' : 'text-spike-red')}>
                  {council.lastTriggerResult.success
                    ? `Last manual run completed — ${council.lastTriggerResult.spikeCount} spikes generated`
                    : `Last manual run failed: ${council.lastTriggerResult.error}`}
                </p>
                <p className="text-spike-text-dim text-xs mt-1">
                  Completed: {new Date(council.lastTriggerResult.completedAt).toLocaleString('en-CA', { timeZone: 'America/Halifax' })}
                </p>
              </div>
            )}

            {/* Error from Python server */}
            {council?.councilHealth?.last_run_error && (
              <div className="glass-card p-4 border border-spike-red/30">
                <p className="text-spike-red text-sm font-bold">Last Python error:</p>
                <p className="text-spike-text-dim text-xs mt-1 mono break-all">{council.councilHealth.last_run_error}</p>
              </div>
            )}

            {/* Trigger Button */}
            <div className="glass-card p-6">
              <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Manual Scan</h3>
              <p className="text-spike-text-dim text-sm mb-4">
                Trigger a full 4-stage LLM council scan. This will screen the entire TSX universe and produce today&apos;s Top 20 spikes.
                Typical runtime is 30-40 minutes.
              </p>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={isRunning || actionLoading === 'council' || council?.councilHealth?.status !== 'ok'}
                className="px-6 py-3 rounded-lg bg-gradient-to-r from-spike-cyan to-spike-violet text-spike-bg font-bold text-sm hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                title={council?.councilHealth?.status !== 'ok' ? 'Python council server is offline' : isRunning ? 'Council is already running' : 'Run council scan'}
              >
                {actionLoading === 'council' ? 'Starting...' : isRunning ? 'Scan in Progress...' : 'Run Council Scan'}
              </button>
            </div>

            {/* Confirmation Modal */}
            {showConfirm && (
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="glass-card p-6 max-w-md w-full border border-spike-cyan/30">
                  <h3 className="text-lg font-bold text-spike-cyan mb-3">Confirm Council Scan</h3>
                  <p className="text-spike-text-dim text-sm mb-2">
                    This will run a full 4-stage LLM council analysis:
                  </p>
                  <ul className="text-spike-text-dim text-xs space-y-1 mb-4 ml-4">
                    <li>Stage 1: Sonnet screens ~300 tickers to Top 100</li>
                    <li>Stage 2: Gemini re-scores to Top 80</li>
                    <li>Stage 3: Opus challenges to Top 40</li>
                    <li>Stage 4: Grok produces final Top 20 with forecasts</li>
                  </ul>
                  <p className="text-spike-amber text-xs mb-4">
                    This will overwrite today&apos;s report if one exists. Estimated time: 30-40 minutes.
                  </p>
                  <div className="flex gap-3 justify-end">
                    <button
                      onClick={() => setShowConfirm(false)}
                      className="px-4 py-2 text-sm rounded-lg border border-spike-border text-spike-text-dim hover:text-spike-text transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={triggerCouncilRun}
                      className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-spike-cyan to-spike-violet text-spike-bg font-bold hover:opacity-90 transition-all"
                    >
                      Start Scan
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Recent Runs Table */}
            <div className="glass-card p-6">
              <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Recent Reports</h3>
              {loading ? (
                <p className="text-spike-text-muted">Loading...</p>
              ) : !council?.recentReports?.length ? (
                <p className="text-spike-text-muted text-sm">No reports generated yet.</p>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[400px]">
                  <thead>
                    <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                      <th className="text-left py-3 px-2">Date</th>
                      <th className="text-left py-3 px-2">Regime</th>
                      <th className="text-center py-3 px-2">Spikes</th>
                      <th className="text-left py-3 px-2">Generated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {council.recentReports.map((r) => (
                      <tr key={r.id} className="border-b border-spike-border/50">
                        <td className="py-3 px-2 text-spike-text mono">
                          {new Date(r.date).toLocaleDateString('en-CA')}
                        </td>
                        <td className="py-3 px-2">
                          <span className={cn('text-xs font-bold uppercase', regimeColor(r.regime))}>
                            {r.regime || '--'}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-center text-spike-cyan font-bold mono">{r.spikeCount}</td>
                        <td className="py-3 px-2 text-spike-text-dim text-xs">
                          {new Date(r.generatedAt).toLocaleString('en-CA', { timeZone: 'America/Halifax' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="legal-footer">
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 2.1</p>
        </div>
    </ResponsiveLayout>
  );
}
