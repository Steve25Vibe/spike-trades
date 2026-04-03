'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ParticleBackground from '@/components/layout/ParticleBackground';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        if (json.mustChangePassword) {
          router.push('/change-password');
        } else {
          router.push('/dashboard');
        }
      } else {
        setError(json.error || 'Access denied.');
        setPassword('');
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
      {/* Background effects */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.05)_0%,transparent_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_20%,rgba(168,85,247,0.05)_0%,transparent_50%)]" />

      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(rgba(0,240,255,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(0,240,255,0.3) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-spike-cyan to-spike-violet flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0A1428" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
            </div>
          </div>
          <h1 className="text-4xl font-display font-bold tracking-wider glow-cyan text-spike-cyan">
            SPIKE TRADES
          </h1>
          <p className="text-spike-text-dim mt-2 text-sm tracking-widest uppercase">
            Today&apos;s Spikes
          </p>
        </div>

        {/* Login card */}
        <div className="glass-card p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all"
                placeholder="your@email.com"
                autoFocus
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono"
                placeholder="Enter password"
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
              disabled={loading || !email || !password}
              className="w-full btn-gradient text-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="31.4 31.4" />
                  </svg>
                  Authenticating...
                </span>
              ) : (
                'Enter Terminal'
              )}
            </button>
          </form>

          <div className="mt-6 text-center space-y-2">
            <Link href="/register" className="text-spike-cyan text-sm hover:text-spike-cyan/80 transition-colors">
              Create an account
            </Link>
            <p className="text-spike-text-muted text-xs">
              Authorized access only. All sessions are logged.
            </p>
          </div>
        </div>

        {/* Legal */}
        <p className="text-center text-spike-text-muted text-[10px] mt-8 leading-relaxed">
          For educational and informational purposes only. Not financial advice.<br />
          Past performance is no guarantee of future results.<br />
          Ver 4.0
        </p>
      </div>
    </div>
  );
}
