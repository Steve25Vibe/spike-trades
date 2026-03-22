'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ParticleBackground from '@/components/layout/ParticleBackground';

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const json = await res.json();
      if (json.success) {
        router.push('/dashboard');
      } else {
        setError(json.error || 'Failed to change password.');
      }
    } catch {
      setError('Connection error. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-spike-bg flex items-center justify-center px-4 relative overflow-hidden">
      <ParticleBackground />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.05)_0%,transparent_70%)]" />

      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-bold tracking-wider glow-cyan text-spike-cyan">
            SPIKE TRADES
          </h1>
          <p className="text-spike-text-dim mt-2 text-sm tracking-widest uppercase">
            Change Your Password
          </p>
          <p className="text-spike-amber text-xs mt-3">
            You must set a new password before continuing.
          </p>
        </div>

        <div className="glass-card p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Current / Temporary Password
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono"
                placeholder="Enter current password"
                autoFocus
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono"
                placeholder="Min 8 chars, upper + lower + number"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Confirm New Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono"
                placeholder="Re-enter new password"
                required
              />
            </div>

            {error && (
              <div className="text-spike-red text-sm text-center bg-spike-red/10 py-2 rounded-lg border border-spike-red/20">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !currentPassword || !newPassword || !confirmPassword}
              className="w-full btn-gradient text-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Updating...' : 'Set New Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
