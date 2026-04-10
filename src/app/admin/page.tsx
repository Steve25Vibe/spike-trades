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
  const [config, setConfig] = useState<{ minAdvDollars: number; updatedAt: string; updatedByEmail: string | null } | null>(null);
  const [configLocalValue, setConfigLocalValue] = useState<number>(5_000_000);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMessage, setConfigMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [analytics, setAnalytics] = useState<Record<string, any> | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [calibrationStatus, setCalibrationStatus] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
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
        await fetchCouncilConfig();
        startPolling();
      } else if (tab === 'analytics') {
        const res = await fetch('/api/admin/analytics');
        const json = await res.json();
        if (json.success) setAnalytics(json.data);
      }
      // LE BYPASS (2026-04-08): the 'learning' tab no longer fetches data.
      // Its content is a static stub stating the Learning Engine is bypassed.
      // See docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
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

  const fetchCouncilConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/council/config');
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          setConfig(json.data);
          setConfigLocalValue(json.data.minAdvDollars);
        }
      }
    } catch (err) {
      console.error('Failed to fetch council config:', err);
    }
  }, []);

  const saveCouncilConfig = async () => {
    setConfigSaving(true);
    setConfigMessage(null);
    try {
      const res = await fetch('/api/admin/council/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minAdvDollars: configLocalValue }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setConfig(json.data);
        setConfigMessage({ type: 'success', text: 'ADV threshold saved. Next council run will use this value.' });
      } else {
        setConfigMessage({ type: 'error', text: json.error || 'Failed to save config' });
      }
    } catch (err) {
      setConfigMessage({ type: 'error', text: 'Network error while saving' });
    } finally {
      setConfigSaving(false);
    }
  };

  const resetConfigToDefault = () => {
    setConfigLocalValue(5_000_000);
    setConfigMessage(null);
  };

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

            {/* ADV Slider Config Panel */}
          <div className="glass-card p-5 mb-4">
            <h3 className="text-sm font-semibold text-spike-text mb-3 uppercase tracking-wider">Council Configuration</h3>

            <div className="mb-4">
              <div className="flex items-baseline justify-between mb-2">
                <label className="text-xs text-spike-text-muted uppercase tracking-wider">
                  Minimum ADV for next run
                </label>
                <span className="text-2xl font-bold mono text-spike-cyan">
                  ${configLocalValue.toLocaleString()}
                </span>
              </div>
              <input
                type="range"
                min={500000}
                max={8000000}
                step={500000}
                value={configLocalValue}
                onChange={(e) => {
                  setConfigLocalValue(Number(e.target.value));
                  setConfigMessage(null);
                }}
                disabled={configSaving}
                className="w-full h-2 bg-spike-bg rounded-lg appearance-none cursor-pointer accent-spike-cyan disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-spike-text-muted mt-1">
                <span>$500k</span>
                <span>$8M</span>
              </div>
            </div>

            {config && (
              <p className="text-[11px] text-spike-text-muted mb-3">
                Last saved: {new Date(config.updatedAt).toLocaleString()}
                {config.updatedByEmail ? ` by ${config.updatedByEmail}` : ''}
                {config.minAdvDollars !== configLocalValue ? (
                  <span className="text-spike-amber ml-2">(unsaved changes)</span>
                ) : null}
              </p>
            )}

            {configMessage && (
              <div className={`text-xs mb-3 ${configMessage.type === 'success' ? 'text-spike-green' : 'text-spike-red'}`}>
                {configMessage.text}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={saveCouncilConfig}
                disabled={configSaving || (config?.minAdvDollars === configLocalValue)}
                className="px-4 py-2 rounded-lg bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/30 hover:bg-spike-cyan/20 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {configSaving ? 'Saving...' : 'Save Configuration'}
              </button>
              <button
                onClick={resetConfigToDefault}
                disabled={configSaving || configLocalValue === 5_000_000}
                className="px-4 py-2 rounded-lg bg-spike-bg text-spike-text-muted border border-spike-border hover:border-spike-cyan/30 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reset to $5M Default
              </button>
            </div>
          </div>

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
            {council?.fmpHealth?.endpoints && (
              <div className="glass-card p-6">
                <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
                  Data Source Health
                </h3>
                {(() => {
                  const sections: { label: string; color: string; endpoints: Record<string, Record<string, number>> }[] = [
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

                {/* Stage Funnel & Calibration — all 4 stages */}
                <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">Stage Funnel &amp; Calibration</h3>
                  <p className="text-xs text-spike-text-muted mb-4">
                    How each LLM scored the candidate universe and how many of its picks made the consensus top 10. All four stages contribute to the final consensus score via weighted average.
                  </p>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="text-spike-text-muted text-xs uppercase border-b border-spike-border">
                        <th className="text-left py-3 px-2">Stage</th>
                        <th className="text-left py-3 px-2">Model</th>
                        <th className="text-center py-3 px-2">Picks Scored</th>
                        <th className="text-center py-3 px-2">Avg Score</th>
                        <th className="text-center py-3 px-2">Score Range</th>
                        <th className="text-center py-3 px-2">In Top 10</th>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>

                {/* Stage 4 Directional Accuracy — Grok only (the only stage that predicts direction) */}
                {(() => {
                  const stage4 = (analytics.stages as Record<string, unknown>[] | undefined)?.find(
                    (s) => (s.stage as number) === 4
                  );
                  if (!stage4) return null;
                  return (
                    <div className="glass-card p-6 border border-spike-violet/20">
                      <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-1">
                        Stage 4 Directional Accuracy
                      </h3>
                      <p className="text-xs text-spike-text-muted mb-4">
                        Stage 4 ({(stage4.model as string) || 'grok'}) is the only stage that produces directional forecasts (UP/DOWN) and magnitude predictions. Earlier stages emit quality scores only and so cannot have a hit rate.
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                        {/* 3d Hit Rate */}
                        <div className="text-center">
                          <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">3-Day Hit Rate</p>
                          <p className={cn('text-2xl font-bold mono', hitRateColor(stage4.hit_rate_3d as number | null))}>
                            {stage4.hit_rate_3d != null ? `${((stage4.hit_rate_3d as number) * 100).toFixed(1)}%` : '—'}
                          </p>
                          <div className="flex items-center justify-center gap-1 mt-1">
                            <span className="text-[9px] text-spike-text-muted mono">n={(stage4.sample_count_3d as number | null) ?? '—'}</span>
                            {(stage4.sample_count_3d as number | null) != null && (stage4.sample_count_3d as number) < 10 && (
                              <span className="px-1 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                            )}
                          </div>
                        </div>
                        {/* 5d Hit Rate */}
                        <div className="text-center">
                          <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">5-Day Hit Rate</p>
                          <p className={cn('text-2xl font-bold mono', hitRateColor(stage4.hit_rate_5d as number | null))}>
                            {stage4.hit_rate_5d != null ? `${((stage4.hit_rate_5d as number) * 100).toFixed(1)}%` : '—'}
                          </p>
                          <div className="flex items-center justify-center gap-1 mt-1">
                            <span className="text-[9px] text-spike-text-muted mono">n={(stage4.sample_count_5d as number | null) ?? '—'}</span>
                            {(stage4.sample_count_5d as number | null) != null && (stage4.sample_count_5d as number) < 10 && (
                              <span className="px-1 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                            )}
                          </div>
                        </div>
                        {/* 8d Hit Rate */}
                        <div className="text-center">
                          <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">8-Day Hit Rate</p>
                          <p className={cn('text-2xl font-bold mono', hitRateColor(stage4.hit_rate_8d as number | null))}>
                            {stage4.hit_rate_8d != null ? `${((stage4.hit_rate_8d as number) * 100).toFixed(1)}%` : '—'}
                          </p>
                          <div className="flex items-center justify-center gap-1 mt-1">
                            <span className="text-[9px] text-spike-text-muted mono">n={(stage4.sample_count_8d as number | null) ?? '—'}</span>
                            {(stage4.sample_count_8d as number | null) != null && (stage4.sample_count_8d as number) < 10 && (
                              <span className="px-1 rounded text-[8px] font-bold uppercase bg-spike-amber/10 text-spike-amber border border-spike-amber/30">Low</span>
                            )}
                          </div>
                        </div>
                        {/* Avg Predicted Move */}
                        <div className="text-center">
                          <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Avg Predicted (3d)</p>
                          <p className="text-2xl font-bold mono text-spike-text">
                            {stage4.avg_predicted_move != null
                              ? `${(stage4.avg_predicted_move as number) >= 0 ? '+' : ''}${(stage4.avg_predicted_move as number).toFixed(2)}%`
                              : '—'}
                          </p>
                          <p className="text-[9px] text-spike-text-muted mt-1">avg forecast magnitude</p>
                        </div>
                        {/* Bias */}
                        <div className="text-center">
                          <p className="text-[10px] text-spike-text-muted uppercase tracking-wider mb-1">Bias</p>
                          <p className={cn(
                            'text-2xl font-bold mono',
                            stage4.bias == null ? 'text-spike-text-dim'
                              : Math.abs(stage4.bias as number) <= 1 ? 'text-spike-green'
                              : Math.abs(stage4.bias as number) <= 2 ? 'text-spike-amber'
                              : 'text-spike-red'
                          )}>
                            {stage4.bias != null
                              ? `${(stage4.bias as number) >= 0 ? '+' : ''}${(stage4.bias as number).toFixed(2)}%`
                              : '—'}
                          </p>
                          <p className="text-[9px] text-spike-text-muted mt-1">predicted − actual</p>
                        </div>
                      </div>
                    </div>
                  );
                })()}

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

        {/* Learning System Tab — BYPASSED 2026-04-08, see spec for details */}
        {tab === 'learning' && (
          <div className="space-y-6">
            <div className="glass-card p-6">
              <div className="flex items-center gap-3 mb-4">
                <span className="w-2 h-2 rounded-full bg-spike-amber" />
                <h3 className="text-sm font-bold text-spike-amber uppercase tracking-wider">
                  Learning Engine — Bypassed
                </h3>
              </div>
              <p className="text-spike-text text-sm mb-3">
                The Learning Engine is currently bypassed pending a full audit and redesign.
                Council runs use the hardcoded stage weights{' '}
                <span className="mono text-spike-cyan">{`{S1: 15%, S2: 20%, S3: 30%, S4: 35%}`}</span>{' '}
                instead of the dynamically computed values.
              </p>
              <p className="text-spike-text-dim text-xs mb-3">
                Reason: a confirmed SQL JOIN defect in <span className="mono">compute_stage_weights()</span> caused
                weights to always collapse to a uniform <span className="mono">{`{0.25 × 4}`}</span>, silently underweighting
                Stage 4 by 10 percentage points relative to design. A parallel statistical-significance
                analysis showed that across 198 resolved accuracy records, none of the council&apos;s
                directional hit rates (3d/5d/8d) are distinguishable from a coin flip at 95% confidence —
                so even bug-free code would be learning from noise at current sample sizes.
              </p>
              <p className="text-spike-text-dim text-xs mb-3">
                The bypass leaves the Learning Engine class and SQLite tables intact for future repair.
                Other mechanisms (sector multiplier, disagreement adjustment, conviction thresholds,
                factor weights, pre-filter) continue to run unchanged, but the buggy{' '}
                <span className="mono">compute_stage_weights()</span> and{' '}
                <span className="mono">build_prompt_context()</span> are no longer called from the
                council pipeline.
              </p>
              <p className="text-spike-text-muted text-[10px] mono">
                Spec: docs/superpowers/specs/2026-04-08-learning-engine-bypass-design.md
              </p>
            </div>
          </div>
        )}

        {/* Calibration Status */}
        <div className="glass-card p-6">
          <h2 className="text-lg font-bold text-spike-text mb-4">Calibration Engine</h2>
          <div className="flex items-center gap-4">
            <button
              onClick={async () => {
                setRefreshing(true);
                try {
                  const res = await fetch('/api/admin/calibration/refresh', { method: 'POST' });
                  const data = await res.json();
                  setCalibrationStatus(data);
                } catch (e) {
                  setCalibrationStatus({ error: String(e) });
                } finally {
                  setRefreshing(false);
                }
              }}
              disabled={refreshing}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20 hover:bg-spike-cyan/20 disabled:opacity-50"
            >
              {refreshing ? 'Running backtest...' : 'Refresh Calibration'}
            </button>
            <span className="text-xs text-spike-text-muted">
              Sunday 04:00 ADT auto-refresh · ~70 min runtime
            </span>
          </div>
          {calibrationStatus && (
            <pre className="mt-4 text-xs text-spike-text-dim bg-spike-bg/50 rounded p-3 overflow-auto">
              {JSON.stringify(calibrationStatus, null, 2)}
            </pre>
          )}
        </div>

        <div className="legal-footer">
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 6.0</p>
        </div>
    </ResponsiveLayout>
  );
}
