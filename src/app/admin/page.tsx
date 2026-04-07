'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';
import { cn } from '@/lib/utils';

type Tab = 'users' | 'invitations' | 'activity' | 'council' | 'analytics' | 'learning';

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

interface StageInfo {
  status: 'pending' | 'running' | 'complete' | 'skipped';
  picks?: number;
  duration_s?: number;
  batches_done?: number;
  batches_total?: number;
  tickers_in?: number;
  tickers_out?: number;
  reason?: string;
}

interface RunStatus {
  running: boolean;
  trigger?: string;
  elapsed_s?: number;
  current_stage?: string;
  stages?: Record<string, StageInfo>;
  last_completed_run?: {
    trigger?: string;
    total_duration_s?: number;
    picks?: number;
    skipped_stages?: string[];
    stages_summary?: Record<string, StageInfo>;
  } | null;
}

interface OpeningBellStatus {
  status?: 'running' | 'complete' | 'failed' | 'pending';
  picks?: number;
  duration_s?: number;
  last_result_summary?: {
    success?: boolean;
    error?: string;
    picks?: number;
    duration_s?: number;
  } | null;
  [key: string]: unknown;
}

interface CouncilStatus {
  councilHealth: { status?: string; council_running?: boolean; last_run_time?: number; last_run_error?: string };
  runInProgress: boolean;
  lastTriggerResult: { success: boolean; error?: string; startedAt?: string; completedAt?: string; spikeCount?: number } | null;
  latestLog: { date: string; processingTimeMs: number | null; consensusScore: number | null } | null;
  recentReports: { id: string; date: string; generatedAt: string; regime: string | null; spikeCount: number }[];
  fmpHealth?: { run_date?: string; endpoints?: Record<string, Record<string, number>> } | null;
  runStatus?: RunStatus | null;
  latestStageMetadata?: {
    token_usage?: {
      stage1?: { model: string; input_tokens: number; output_tokens: number };
      stage2?: { model: string; input_tokens: number; output_tokens: number };
      stage3?: { model: string; input_tokens: number; output_tokens: number };
      stage4?: { model: string; input_tokens: number; output_tokens: number };
    };
    [key: string]: unknown;
  } | null;
  openingBellStatus?: OpeningBellStatus | null;
  openingBellHealth?: { endpoints?: Record<string, Record<string, number>> } | null;
  radarStatus?: { running?: boolean; picks_count?: number; last_run_time?: number; last_error?: string; status?: string } | null;
  radarHealth?: { endpoints?: Record<string, Record<string, number>> } | null;
  radarAccuracy?: {
    total: number;
    correct: number;
    hitRate: number | null;
    avgOpenMove: number | null;
    passedOpeningBell: number;
    passedSpikes: number;
  } | null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatDurationMs(ms: number): string {
  return formatDuration(Math.round(ms / 1000));
}

// API pricing per million tokens (USD) — update when provider prices change
const LLM_PRICING: Record<string, { input: number; output: number; label: string }> = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, label: 'Sonnet 4.6' },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, label: 'Sonnet 4' },
  'claude-opus-4-6': { input: 5.00, output: 25.00, label: 'Opus 4.6' },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00, label: 'Opus 4' },
  'gemini-3.1-pro-preview': { input: 1.25, output: 10.00, label: 'Gemini 3.1 Pro' },
  'gemini-3.1-pro': { input: 1.25, output: 10.00, label: 'Gemini 3.1 Pro' },
  'grok-4-0709': { input: 3.00, output: 15.00, label: 'Grok 4 (legacy)' },
  'grok-4.20-multi-agent-0309': { input: 2.00, output: 6.00, label: 'Grok 4.20 Multi-Agent' },
};
const FALLBACK_PRICING = { input: 15.00, output: 75.00, label: 'Unknown' };

function calculateStageCost(stage: { model: string; input_tokens: number; output_tokens: number }) {
  const pricing = LLM_PRICING[stage.model] || FALLBACK_PRICING;
  const cost = (stage.input_tokens / 1_000_000) * pricing.input + (stage.output_tokens / 1_000_000) * pricing.output;
  return { cost, pricing };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [activity, setActivity] = useState<{ totalUsers: number; activeToday: number; avgSessionDurationSec: number; perUser: ActivityUser[] } | null>(null);
  const [council, setCouncil] = useState<CouncilStatus | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [analytics, setAnalytics] = useState<Record<string, any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [learning, setLearning] = useState<Record<string, any> | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Stop council polling when navigating away
    if (tab !== 'council') stopPolling();
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
        startPolling();
      } else if (tab === 'analytics') {
        const res = await fetch('/api/admin/analytics');
        const json = await res.json();
        if (json.success) setAnalytics(json.data);
      } else if (tab === 'learning') {
        const res = await fetch('/api/admin/learning');
        const json = await res.json();
        if (json.success && json.data?.success) {
          setLearning(json.data);
        }
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
        // Adjust poll speed based on run state
        const isRunning = json.data.runInProgress;
        const currentInterval = pollRef.current ? pollIntervalRef.current : 0;
        const targetInterval = isRunning ? 5000 : 15000;
        if (currentInterval !== targetInterval && pollRef.current) {
          // Switch poll speed
          clearInterval(pollRef.current);
          pollRef.current = setInterval(() => { fetchCouncilStatusRef.current(); }, targetInterval);
          pollIntervalRef.current = targetInterval;
        }
        // Start/stop elapsed timer based on run state
        if (isRunning && !timerRef.current) {
          const startTime = Date.now() - (json.data.runStatus?.elapsed_s ?? 0) * 1000;
          timerRef.current = setInterval(() => {
            setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
          }, 1000);
        }
        if (!isRunning && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    } catch { /* silent — will retry on next poll */ }
  }, []);

  // Stable ref for fetchCouncilStatus so setInterval always calls latest version
  const fetchCouncilStatusRef = useRef(fetchCouncilStatus);
  fetchCouncilStatusRef.current = fetchCouncilStatus;
  const pollIntervalRef = useRef(0);

  const startPolling = () => {
    if (pollRef.current) return;
    const interval = 15000; // Start at 15s, switches to 5s if run detected
    pollRef.current = setInterval(() => { fetchCouncilStatusRef.current(); }, interval);
    pollIntervalRef.current = interval;
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; pollIntervalRef.current = 0; }
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

  const triggerOpeningBell = async () => {
    try {
      await fetch('/api/admin/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'opening-bell' }),
      });
    } catch { /* polling will pick up status */ }
  };

  const triggerRadar = async () => {
    try {
      await fetch('/api/admin/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'radar' }),
      });
    } catch { /* polling will pick up status */ }
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

  const hitRateColor = (rate: number | null | undefined) => {
    if (rate == null) return 'text-spike-text-dim';
    if (rate >= 0.60) return 'text-spike-green';
    if (rate >= 0.50) return 'text-spike-amber';
    return 'text-spike-red';
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
          {(['users', 'invitations', 'activity', 'council', 'analytics', 'learning'] as const).map((t) => (
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
            {/* 1. Python Server Status */}
            <div className="glass-card p-4 flex items-center justify-center gap-3">
              <p className="text-xs text-spike-text-muted uppercase tracking-wider">Python Server</p>
              {(() => {
                const status = council?.councilHealth?.status;
                const isRunning = council?.runInProgress || council?.councilHealth?.council_running;
                if (status === 'ok') return <span className="text-lg font-bold mono text-spike-green">Online</span>;
                if (isRunning) return <span className="text-lg font-bold mono text-spike-amber">Busy</span>;
                return <span className="text-lg font-bold mono text-spike-red">Offline</span>;
              })()}
            </div>

            {/* 2. Radar Scanner (first in pipeline sequence) */}
            {(() => {
              const radar = council?.radarStatus;
              const status = radar?.status ?? 'pending';
              const statusColorMap: Record<string, string> = {
                running: 'text-spike-amber',
                complete: 'text-spike-green',
                failed: 'text-spike-red',
                pending: 'text-spike-text-dim',
              };
              const statusText = radar?.running ? 'Running' : status.charAt(0).toUpperCase() + status.slice(1);
              const picks = radar?.picks_count ?? null;
              const duration = radar?.last_run_time ?? null;
              const error = radar?.last_error ?? null;
              return (
                <div className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-green-400 uppercase tracking-wider">Radar Scanner</span>
                    <button
                      onClick={triggerRadar}
                      className="px-3 py-1.5 rounded-lg bg-green-400/10 text-green-400 text-xs font-bold hover:bg-green-400/20 transition-all border border-green-400/30"
                    >
                      Run Radar
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Status</p>
                      <p className={cn('text-sm font-bold mono', radar?.running ? 'text-spike-amber' : statusColorMap[status] ?? 'text-spike-text-dim')}>{statusText}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Picks</p>
                      <p className="text-sm font-bold mono text-green-400">{picks ?? '--'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Duration</p>
                      <p className="text-sm font-bold mono text-spike-text">{duration != null ? formatDuration(Math.round(duration)) : '--'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Last Run</p>
                      <p className="text-sm font-bold mono text-spike-text-dim">{duration != null ? new Date().toLocaleDateString('en-CA') : '--'}</p>
                    </div>
                  </div>
                  {error && (
                    <div className="mt-3 p-2 rounded bg-spike-red/10 border border-spike-red/20">
                      <p className="text-xs text-spike-red mono break-all">{error}</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 2b. Radar Accuracy (moved from public Accuracy Engine in Session 13) */}
            {council?.radarAccuracy && council.radarAccuracy.total > 0 && (
              <div className="glass-card p-5 border border-green-400/20">
                <div className="flex items-center gap-2 mb-4">
                  <span className="w-3 h-3 rounded-full bg-green-400" />
                  <span className="text-xs font-bold text-green-400 uppercase tracking-wider">
                    Radar Accuracy — Pre-Market Signal
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className={cn(
                      'text-2xl font-bold mono',
                      (council.radarAccuracy.hitRate ?? 0) >= 55 ? 'text-spike-green'
                        : (council.radarAccuracy.hitRate ?? 0) >= 50 ? 'text-spike-amber'
                        : 'text-spike-red'
                    )}>
                      {council.radarAccuracy.hitRate != null ? `${council.radarAccuracy.hitRate.toFixed(1)}%` : '—'}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Open Direction Hit Rate</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold mono text-spike-text">
                      {council.radarAccuracy.correct}/{council.radarAccuracy.total}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Correct / Total</p>
                  </div>
                  <div>
                    <p className={cn(
                      'text-2xl font-bold mono',
                      (council.radarAccuracy.avgOpenMove ?? 0) >= 0 ? 'text-spike-green' : 'text-spike-red'
                    )}>
                      {council.radarAccuracy.avgOpenMove != null
                        ? `${(council.radarAccuracy.avgOpenMove >= 0 ? '+' : '')}${council.radarAccuracy.avgOpenMove.toFixed(2)}%`
                        : '—'}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Avg Open Move</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold mono text-spike-text">
                      {council.radarAccuracy.passedSpikes}/{council.radarAccuracy.total}
                    </p>
                    <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mt-1">Made Final Spikes</p>
                  </div>
                </div>
              </div>
            )}

            {/* 3. Opening Bell (second in pipeline sequence) */}
            {(() => {
              const ob = council?.openingBellStatus;
              const status = ob?.status ?? 'pending';
              const statusColorMap: Record<string, string> = {
                running: 'text-spike-amber',
                complete: 'text-spike-green',
                failed: 'text-spike-red',
                pending: 'text-spike-text-dim',
              };
              const statusText = status.charAt(0).toUpperCase() + status.slice(1);
              const picks = ob?.picks ?? ob?.last_result_summary?.picks ?? null;
              const duration = ob?.duration_s ?? ob?.last_result_summary?.duration_s ?? null;
              const error = ob?.last_result_summary?.success === false ? ob?.last_result_summary?.error : null;
              return (
                <div className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-spike-amber uppercase tracking-wider">Opening Bell</span>
                    <button
                      onClick={triggerOpeningBell}
                      className="px-3 py-1.5 rounded-lg bg-spike-amber/10 text-spike-amber text-xs font-bold hover:bg-spike-amber/20 transition-all border border-spike-amber/30"
                    >
                      Run Opening Bell
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Status</p>
                      <p className={cn('text-sm font-bold mono', statusColorMap[status] ?? 'text-spike-text-dim')}>{statusText}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Picks</p>
                      <p className="text-sm font-bold mono text-spike-cyan">{picks ?? '--'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Duration</p>
                      <p className="text-sm font-bold mono text-spike-text">{duration != null ? formatDuration(Math.round(duration)) : '--'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Last Run</p>
                      <p className="text-sm font-bold mono text-spike-text-dim">{duration != null ? new Date().toLocaleDateString('en-CA') : '--'}</p>
                    </div>
                  </div>
                  {error && (
                    <div className="mt-3 p-2 rounded bg-spike-red/10 border border-spike-red/20">
                      <p className="text-xs text-spike-red mono break-all">{error}</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 4. Today's Spikes — Stage Pipeline Visualization */}
            {(() => {
              const STAGE_KEYS = ['pre_filter', 'stage1_sonnet', 'stage2_gemini', 'stage3_opus', 'stage4_grok', 'consensus'] as const;
              const STAGE_LABELS: Record<string, string> = {
                pre_filter: 'Filter',
                stage1_sonnet: 'Sonnet',
                stage2_gemini: 'Gemini',
                stage3_opus: 'Opus',
                stage4_grok: 'Grok',
                consensus: 'Consensus',
              };

              const runStatus = council?.runStatus;
              const isLive = runStatus?.running ?? false;
              const stagesData: Record<string, StageInfo> = isLive
                ? (runStatus?.stages ?? {})
                : (runStatus?.last_completed_run?.stages_summary ?? {});

              const triggerLabel = isLive
                ? (runStatus?.trigger === 'manual' ? 'Manual run' : 'Scheduled run')
                : runStatus?.last_completed_run?.trigger === 'manual'
                  ? 'Manual run'
                  : runStatus?.last_completed_run?.trigger
                    ? 'Scheduled run'
                    : null;

              const headerDuration = isLive
                ? formatDuration(runStatus?.elapsed_s ?? elapsedTime)
                : runStatus?.last_completed_run?.total_duration_s != null
                  ? formatDuration(runStatus.last_completed_run.total_duration_s!)
                  : null;

              return (
                <div className="glass-card p-5">
                  {/* Header row */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      {isLive && (
                        <span className="inline-block w-2.5 h-2.5 rounded-full bg-spike-amber animate-pulse" />
                      )}
                      <span className="text-xs font-bold text-spike-cyan uppercase tracking-wider">
                        {isLive ? 'Today\'s Spikes — Running' : 'Today\'s Spikes'}
                      </span>
                      {!isLive && council?.recentReports?.[0] && (
                        <span className="text-xs text-spike-text-muted">
                          — {String(council.recentReports[0].date).slice(0, 10)} · {council.recentReports[0].spikeCount} spikes · {headerDuration ?? ''}
                        </span>
                      )}
                      {isLive && headerDuration && (
                        <span className="text-xs mono text-spike-text-dim ml-2">{headerDuration}</span>
                      )}
                    </div>
                    <button
                      onClick={() => setShowConfirm(true)}
                      disabled={isRunning || actionLoading === 'council' || council?.councilHealth?.status !== 'ok'}
                      className="px-3 py-1.5 rounded-lg bg-spike-cyan/10 text-spike-cyan text-xs font-bold hover:bg-spike-cyan/20 transition-all border border-spike-cyan/30 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={council?.councilHealth?.status !== 'ok' ? 'Python server offline' : isRunning ? 'Already running' : 'Run council scan'}
                    >
                      {isRunning ? 'Running...' : 'Run Council Scan'}
                    </button>
                  </div>

                  {/* Stage cards */}
                  <div className="flex gap-2 flex-wrap sm:flex-nowrap">
                    {STAGE_KEYS.map((key) => {
                      const stage = stagesData[key];
                      const status = stage?.status ?? 'pending';
                      const label = STAGE_LABELS[key];

                      let cardClass = 'bg-gray-800/50 border border-gray-700/30';
                      let textClass = 'text-spike-text-muted';
                      if (status === 'running') {
                        cardClass = 'bg-amber-500/10 border border-amber-500/30 animate-pulse';
                        textClass = 'text-spike-amber';
                      } else if (status === 'complete') {
                        cardClass = 'bg-green-500/10 border border-green-500/30';
                        textClass = 'text-spike-green';
                      } else if (status === 'skipped') {
                        cardClass = 'bg-red-500/10 border border-red-500/30';
                        textClass = 'text-spike-red';
                      }

                      return (
                        <div
                          key={key}
                          className={cn('flex-1 min-w-[60px] rounded-lg p-2.5 text-center', cardClass)}
                        >
                          <p className={cn('text-[10px] font-bold uppercase tracking-wide', textClass)}>{label}</p>
                          {status === 'complete' && (
                            <>
                              {stage?.picks != null && (
                                <p className="text-[11px] font-bold text-spike-green mono mt-0.5">{stage.picks}</p>
                              )}
                              {stage?.duration_s != null && (
                                <p className="text-[9px] text-spike-text-muted mono">{formatDuration(Math.round(stage.duration_s))}</p>
                              )}
                            </>
                          )}
                          {status === 'skipped' && (
                            <p className="text-[9px] text-spike-red mono mt-0.5">Skip</p>
                          )}
                          {status === 'running' && (
                            <p className="text-[9px] text-spike-amber mono mt-0.5">…</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 5. Run Cost Breakdown (Today's Spikes only) */}
            {(() => {
              const tokenUsage = council?.latestStageMetadata?.token_usage;
              if (!tokenUsage) return (
                <div className="glass-card p-4">
                  <p className="text-xs text-spike-text-muted uppercase tracking-wider mb-2">Run Cost Breakdown</p>
                  <p className="text-xs text-spike-text-dim">Token data not available for this run</p>
                </div>
              );

              const stages = [
                { key: 'stage1', label: 'Stage 1', ...(tokenUsage.stage1 || { model: 'skipped', input_tokens: 0, output_tokens: 0 }) },
                { key: 'stage2', label: 'Stage 2', ...(tokenUsage.stage2 || { model: 'skipped', input_tokens: 0, output_tokens: 0 }) },
                { key: 'stage3', label: 'Stage 3', ...(tokenUsage.stage3 || { model: 'skipped', input_tokens: 0, output_tokens: 0 }) },
                { key: 'stage4', label: 'Stage 4', ...(tokenUsage.stage4 || { model: 'skipped', input_tokens: 0, output_tokens: 0 }) },
              ].filter(s => s.model && s.model !== 'skipped');

              let totalCost = 0;
              const rows = stages.map(s => {
                const { cost, pricing } = calculateStageCost(s);
                totalCost += cost;
                return { ...s, cost, displayLabel: `${s.label} · ${pricing.label}` };
              });

              return (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-spike-text-muted uppercase tracking-wider">Run Cost Breakdown</p>
                    <span className="text-[10px] text-spike-text-dim">Today&apos;s Spikes only</span>
                  </div>
                  <div className="space-y-2">
                    {rows.map(r => (
                      <div key={r.key} className="flex items-center justify-between text-xs">
                        <div>
                          <span className="text-spike-text">{r.displayLabel}</span>
                          <span className="text-spike-text-dim ml-2">{formatTokens(r.input_tokens)} in / {formatTokens(r.output_tokens)} out</span>
                        </div>
                        <span className="text-spike-cyan mono font-medium">${r.cost.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-spike-border/30 mt-3 pt-3 flex items-center justify-between">
                    <span className="text-xs font-bold text-spike-text">Total</span>
                    <span className="text-lg font-bold text-spike-cyan mono">${totalCost.toFixed(2)}</span>
                  </div>
                </div>
              );
            })()}

            {/* 6. Last trigger result */}
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
                    <li>Stage 4: Grok produces final Top 10 with forecasts</li>
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

            {/* 8. Recent Reports */}
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

            {/* 9. Data Source Health — per scanner */}
            {(council?.radarHealth?.endpoints || council?.openingBellHealth?.endpoints || council?.fmpHealth?.endpoints) && (
              <div className="glass-card p-6">
                <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
                  Data Source Health
                </h3>
                {(() => {
                  const sections: { label: string; color: string; endpoints: Record<string, Record<string, number>> }[] = [
                    { label: 'Radar', color: 'text-green-400', endpoints: (council?.radarHealth?.endpoints || {}) as Record<string, Record<string, number>> },
                    { label: 'Opening Bell', color: 'text-spike-amber', endpoints: (council?.openingBellHealth?.endpoints || {}) as Record<string, Record<string, number>> },
                    { label: 'Today\'s Spikes', color: 'text-spike-cyan', endpoints: (council?.fmpHealth?.endpoints || {}) as Record<string, Record<string, number>> },
                  ].filter(s => Object.keys(s.endpoints).length > 0);

                  return (
                    <div className="space-y-6">
                      {sections.map((section) => (
                        <div key={section.label}>
                          <p className={cn('text-xs font-bold uppercase tracking-wider mb-2', section.color)}>{section.label}</p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-spike-text-muted text-[10px] uppercase tracking-wider border-b border-spike-border/30">
                                  <th className="py-2 text-left">Endpoint</th>
                                  <th className="py-2 text-center">OK</th>
                                  <th className="py-2 text-center">404</th>
                                  <th className="py-2 text-center">429</th>
                                  <th className="py-2 text-center">Error</th>
                                  <th className="py-2 text-center">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {Object.entries(section.endpoints).map(([endpoint, counts]) => {
                                  const ok = counts.ok || 0;
                                  const not_found = counts['404'] || 0;
                                  const rate_limited = counts['429'] || 0;
                                  const errors = counts.error || 0;
                                  const total = ok + not_found + rate_limited + errors;
                                  const healthPct = total > 0 ? (ok / total) * 100 : 0;
                                  const status = not_found > 0 && ok === 0
                                    ? 'DEPRECATED'
                                    : rate_limited > ok
                                      ? 'THROTTLED'
                                      : healthPct >= 90
                                        ? 'HEALTHY'
                                        : healthPct >= 50
                                          ? 'DEGRADED'
                                          : 'FAILING';
                                  const statusColor = {
                                    HEALTHY: 'text-spike-green',
                                    DEGRADED: 'text-spike-amber',
                                    THROTTLED: 'text-spike-amber',
                                    DEPRECATED: 'text-spike-red',
                                    FAILING: 'text-spike-red',
                                  }[status];
                                  return (
                                    <tr key={endpoint} className="border-b border-spike-border/10">
                                      <td className="py-2 mono text-spike-text text-xs">{endpoint}</td>
                                      <td className="py-2 text-center mono text-spike-green">{ok || '-'}</td>
                                      <td className="py-2 text-center mono text-spike-red">{not_found || '-'}</td>
                                      <td className="py-2 text-center mono text-spike-amber">{rate_limited || '-'}</td>
                                      <td className="py-2 text-center mono text-spike-red">{errors || '-'}</td>
                                      <td className={cn('py-2 text-center font-bold text-[10px] uppercase', statusColor)}>
                                        {status}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* Analytics Tab */}
        {tab === 'analytics' && (
          <div className="space-y-6">
            {loading ? (
              <p className="text-spike-text-muted">Loading analytics...</p>
            ) : !analytics ? (
              <p className="text-spike-text-muted">No analytics data available. Run a council scan first.</p>
            ) : (
              <>
                {/* Last updated + Export row */}
                <div className="flex items-center justify-between gap-4">
                  {/* Last computed timestamp */}
                  <div className="flex items-center gap-2">
                    {analytics.summary?.last_updated ? (() => {
                      const lastUpdated = new Date(analytics.summary.last_updated);
                      const now = new Date();
                      const hoursOld = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60);
                      const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
                      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
                      const isStale = hoursOld > 24 && isWeekday;
                      const formatted = lastUpdated.toLocaleString('en-CA', {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      });
                      return (
                        <>
                          <span className="text-xs text-spike-text-muted">Last computed: {formatted}</span>
                          {isStale && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-spike-red/10 text-spike-red border border-spike-red/30">
                              Stale data
                            </span>
                          )}
                        </>
                      );
                    })() : (
                      <span className="text-xs text-spike-text-muted">Last computed: —</span>
                    )}
                  </div>
                  {/* Export button */}
                  <div>
                    <a
                      href="/api/admin/analytics?export=xlsx"
                      className="px-4 py-2 rounded-lg bg-gradient-to-r from-spike-cyan to-spike-violet text-spike-bg font-bold text-sm hover:opacity-90 transition-all"
                      title="Download full analytics as Excel spreadsheet"
                    >
                      Download XLSX
                    </a>
                  </div>
                </div>

                {/* Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Total Picks</p>
                    <p className="text-xl font-bold text-spike-cyan mono">{analytics.summary?.total_picks || 0}</p>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">3-Day Hit Rate</p>
                    <p className={cn('text-xl font-bold mono', hitRateColor(analytics.summary?.hit_rate_3d))}>
                      {analytics.summary?.hit_rate_3d != null ? `${(analytics.summary.hit_rate_3d * 100).toFixed(1)}%` : '—'}
                    </p>
                    <div className="flex items-center justify-center gap-1.5 mt-1">
                      <span className="text-[8px] text-spike-text-muted mono">
                        n={analytics.summary?.total_picks_with_3d ?? '—'}
                      </span>
                      {(analytics.summary?.total_picks_with_3d ?? 0) > 0 && (analytics.summary?.total_picks_with_3d ?? 0) < 10 && (
                        <span className="px-1 py-0 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low sample</span>
                      )}
                    </div>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">5-Day Hit Rate</p>
                    <p className={cn('text-xl font-bold mono', hitRateColor(analytics.summary?.hit_rate_5d))}>
                      {analytics.summary?.hit_rate_5d != null ? `${(analytics.summary.hit_rate_5d * 100).toFixed(1)}%` : '—'}
                    </p>
                    <div className="flex items-center justify-center gap-1.5 mt-1">
                      <span className="text-[8px] text-spike-text-muted mono">
                        n={analytics.summary?.total_picks_with_5d ?? '—'}
                      </span>
                      {(analytics.summary?.total_picks_with_5d ?? 0) > 0 && (analytics.summary?.total_picks_with_5d ?? 0) < 10 && (
                        <span className="px-1 py-0 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low sample</span>
                      )}
                    </div>
                  </div>
                  <div className="glass-card p-4 text-center">
                    <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">8-Day Hit Rate</p>
                    <p className={cn('text-xl font-bold mono', hitRateColor(analytics.summary?.hit_rate_8d))}>
                      {analytics.summary?.hit_rate_8d != null ? `${(analytics.summary.hit_rate_8d * 100).toFixed(1)}%` : '—'}
                    </p>
                    <div className="flex items-center justify-center gap-1.5 mt-1">
                      <span className="text-[8px] text-spike-text-muted mono">
                        n={analytics.summary?.total_picks_with_8d ?? '—'}
                      </span>
                      {(analytics.summary?.total_picks_with_8d ?? 0) > 0 && (analytics.summary?.total_picks_with_8d ?? 0) < 10 && (
                        <span className="px-1 py-0 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low sample</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Stage Performance Table */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">LLM Stage Performance</h3>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[800px]">
                    <thead>
                      <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                        <th className="text-left py-3 px-2">Stage</th>
                        <th className="text-left py-3 px-2">Model</th>
                        <th className="text-center py-3 px-2">Picks Scored</th>
                        <th className="text-center py-3 px-2">Avg Score</th>
                        <th className="text-center py-3 px-2">Score Range</th>
                        <th className="text-center py-3 px-2">In Top 10</th>
                        <th className="text-center py-3 px-2">3d Hit Rate</th>
                        <th className="text-center py-3 px-2">5d Hit Rate</th>
                        <th className="text-center py-3 px-2">8d Hit Rate</th>
                        <th className="text-center py-3 px-2">Bias</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.stages?.map((s: Record<string, unknown>) => (
                        <tr key={s.stage as number} className="border-b border-spike-border/50">
                          <td className="py-3 px-2 text-spike-cyan font-bold">Stage {s.stage as number}</td>
                          <td className="py-3 px-2 text-spike-text capitalize">{s.model as string}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">{s.total_picks_scored as number}</td>
                          <td className="py-3 px-2 text-center text-spike-text mono">{s.avg_score != null ? (s.avg_score as number).toFixed(1) : '—'}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono text-xs">
                            {s.min_score != null ? `${(s.min_score as number).toFixed(0)}–${(s.max_score as number).toFixed(0)}` : '—'}
                          </td>
                          <td className="py-3 px-2 text-center text-spike-text mono">{s.picks_in_top20 as number}</td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(s.hit_rate_3d as number | null))}>
                            <div>{s.hit_rate_3d != null ? `${((s.hit_rate_3d as number) * 100).toFixed(1)}%` : '—'}</div>
                            <div className="flex items-center justify-center gap-1 mt-0.5">
                              <span className="text-[8px] text-spike-text-muted">n={(s.sample_count_3d as number | null) ?? '—'}</span>
                              {(s.sample_count_3d as number | null) != null && (s.sample_count_3d as number) < 10 && (
                                <span className="px-1 rounded text-[7px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                              )}
                            </div>
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(s.hit_rate_5d as number | null))}>
                            <div>{s.hit_rate_5d != null ? `${((s.hit_rate_5d as number) * 100).toFixed(1)}%` : '—'}</div>
                            <div className="flex items-center justify-center gap-1 mt-0.5">
                              <span className="text-[8px] text-spike-text-muted">n={(s.sample_count_5d as number | null) ?? '—'}</span>
                              {(s.sample_count_5d as number | null) != null && (s.sample_count_5d as number) < 10 && (
                                <span className="px-1 rounded text-[7px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                              )}
                            </div>
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(s.hit_rate_8d as number | null))}>
                            <div>{s.hit_rate_8d != null ? `${((s.hit_rate_8d as number) * 100).toFixed(1)}%` : '—'}</div>
                            <div className="flex items-center justify-center gap-1 mt-0.5">
                              <span className="text-[8px] text-spike-text-muted">n={(s.sample_count_8d as number | null) ?? '—'}</span>
                              {(s.sample_count_8d as number | null) != null && (s.sample_count_8d as number) < 10 && (
                                <span className="px-1 rounded text-[7px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">
                            {s.bias != null ? `${(s.bias as number) > 0 ? '+' : ''}${(s.bias as number).toFixed(2)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>

                {/* Score vs Outcome */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Score vs Outcome</h3>
                  <p className="text-spike-text-dim text-xs mb-4">Do higher consensus scores lead to better actual outcomes?</p>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[400px]">
                    <thead>
                      <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                        <th className="text-left py-3 px-2">Score Bucket</th>
                        <th className="text-center py-3 px-2">Picks</th>
                        <th className="text-center py-3 px-2">Avg Actual Return</th>
                        <th className="text-center py-3 px-2">Hit Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.score_buckets?.map((b: Record<string, unknown>) => (
                        <tr key={b.bucket as string} className="border-b border-spike-border/50">
                          <td className="py-3 px-2 text-spike-text font-bold mono">{b.bucket as string}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">{b.picks as number}</td>
                          <td className={cn('py-3 px-2 text-center mono', (b.avg_actual_return as number) > 0 ? 'text-spike-green' : (b.avg_actual_return as number) < 0 ? 'text-spike-red' : 'text-spike-text-dim')}>
                            {b.avg_actual_return != null ? `${(b.avg_actual_return as number) > 0 ? '+' : ''}${(b.avg_actual_return as number).toFixed(2)}%` : '—'}
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(b.hit_rate as number | null))}>
                            {b.hit_rate != null ? `${((b.hit_rate as number) * 100).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>

                {/* Daily Accuracy Trend */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">Daily Accuracy Trend</h3>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                        <th className="text-left py-3 px-2">Date</th>
                        <th className="text-center py-3 px-2">Picks</th>
                        <th className="text-center py-3 px-2">3d Correct</th>
                        <th className="text-center py-3 px-2">3d Rate</th>
                        <th className="text-center py-3 px-2">5d Correct</th>
                        <th className="text-center py-3 px-2">5d Rate</th>
                        <th className="text-center py-3 px-2">8d Correct</th>
                        <th className="text-center py-3 px-2">8d Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.daily?.map((d: Record<string, unknown>) => (
                        <tr key={d.date as string} className="border-b border-spike-border/50">
                          <td className="py-3 px-2 text-spike-text mono">{d.date as string}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">{d.picks as number}</td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">
                            {(d.checked_3d as number) > 0 ? `${d.correct_3d}/${d.checked_3d}` : '—'}
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(d.hit_rate_3d as number | null))}>
                            {d.hit_rate_3d != null ? `${((d.hit_rate_3d as number) * 100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">
                            {(d.checked_5d as number) > 0 ? `${d.correct_5d}/${d.checked_5d}` : '—'}
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(d.hit_rate_5d as number | null))}>
                            {d.hit_rate_5d != null ? `${((d.hit_rate_5d as number) * 100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="py-3 px-2 text-center text-spike-text-dim mono">
                            {(d.checked_8d as number) > 0 ? `${d.correct_8d}/${d.checked_8d}` : '—'}
                          </td>
                          <td className={cn('py-3 px-2 text-center mono', hitRateColor(d.hit_rate_8d as number | null))}>
                            {d.hit_rate_8d != null ? `${((d.hit_rate_8d as number) * 100).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Learning System Tab */}
        {tab === 'learning' && (
          <div className="space-y-6">
            {loading ? (
              <p className="text-spike-text-muted">Loading learning system state...</p>
            ) : !learning ? (
              <p className="text-spike-text-muted">Learning system not available. Ensure council server is running.</p>
            ) : (
              <>
                {/* Section 1: Mechanism Dashboard */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
                    Mechanism Activation Status
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {learning.mechanisms?.map((m: { name: string; active: boolean; progress: number | string; gate: number }, i: number) => (
                      <div key={i} className={cn(
                        'rounded-xl p-4 border',
                        m.active
                          ? 'bg-spike-green/5 border-spike-green/30'
                          : 'bg-spike-bg/50 border-spike-border'
                      )}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={cn(
                            'w-2 h-2 rounded-full',
                            m.active ? 'bg-spike-green' : 'bg-spike-text-muted'
                          )} />
                          <span className={cn(
                            'text-xs font-bold uppercase',
                            m.active ? 'text-spike-green' : 'text-spike-text-muted'
                          )}>
                            {m.active ? 'Active' : 'Waiting'}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-spike-text mb-2">{m.name}</p>
                        {typeof m.progress === 'number' && m.gate > 0 ? (
                          <>
                            <div className="w-full h-1.5 bg-spike-bg rounded-full overflow-hidden mb-1">
                              <div
                                className={cn('h-full rounded-full transition-all', m.active ? 'bg-spike-green' : 'bg-spike-cyan')}
                                style={{ width: `${Math.min((m.progress / m.gate) * 100, 100)}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-spike-text-muted mono">
                              {m.progress}/{m.gate} resolved picks
                            </p>
                          </>
                        ) : (
                          <p className="text-[10px] text-spike-text-muted mono">
                            {typeof m.progress === 'string' ? m.progress : 'No gate required'}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 2: Current Stage Weights */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
                    Current Stage Weights
                  </h3>
                  <p className="text-spike-text-dim text-xs mb-4">
                    How much influence each LLM stage has on the final consensus score. Default: S1=15%, S2=20%, S3=30%, S4=35%.
                  </p>
                  <div className="grid grid-cols-4 gap-4">
                    {Object.entries(learning.current_stage_weights || {}).map(([stage, weight]) => {
                      const defaults: Record<string, number> = {'1': 0.15, '2': 0.20, '3': 0.30, '4': 0.35};
                      const defaultW = defaults[stage] || 0.25;
                      const w = weight as number;
                      const delta = ((w - defaultW) * 100).toFixed(1);
                      const deltaNum = parseFloat(delta);
                      const stageNames: Record<string, string> = {'1': 'Sonnet', '2': 'Gemini', '3': 'Opus', '4': 'Grok'};
                      return (
                        <div key={stage} className="glass-card p-4 text-center">
                          <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">
                            Stage {stage} ({stageNames[stage]})
                          </p>
                          <p className="text-xl font-bold text-spike-cyan mono">
                            {(w * 100).toFixed(1)}%
                          </p>
                          {deltaNum !== 0 && (
                            <p className={cn('text-xs mono', deltaNum > 0 ? 'text-spike-green' : 'text-spike-red')}>
                              {deltaNum > 0 ? '+' : ''}{delta}% vs default
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="legal-footer">
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 5.0</p>
        </div>
    </ResponsiveLayout>
  );
}
