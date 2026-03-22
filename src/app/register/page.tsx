'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ParticleBackground from '@/components/layout/ParticleBackground';

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-spike-bg" />}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState(searchParams.get('code') || '');
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const passwordStrength = () => {
    if (!password) return null;
    let score = 0;
    if (password.length >= 8) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    return score;
  };

  const strengthLabel = () => {
    const s = passwordStrength();
    if (s === null) return null;
    if (s <= 1) return { text: 'Weak', color: 'text-spike-red' };
    if (s <= 2) return { text: 'Fair', color: 'text-spike-amber' };
    if (s <= 3) return { text: 'Good', color: 'text-spike-cyan' };
    return { text: 'Strong', color: 'text-spike-green' };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, invitationCode: code }),
      });

      const json = await res.json();
      if (json.success) {
        router.push('/dashboard');
      } else {
        setError(json.error || 'Registration failed.');
      }
    } catch {
      setError('Connection error. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const strength = strengthLabel();

  return (
    <div className="min-h-screen bg-spike-bg flex items-center justify-center px-4 relative overflow-hidden">
      <ParticleBackground />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,240,255,0.05)_0%,transparent_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_20%,rgba(168,85,247,0.05)_0%,transparent_50%)]" />
      <div className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(rgba(0,240,255,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(0,240,255,0.3) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative z-10 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-bold tracking-wider glow-cyan text-spike-cyan">
            SPIKE TRADES
          </h1>
          <p className="text-spike-text-dim mt-2 text-sm tracking-widest uppercase">
            Create Your Account
          </p>
        </div>

        <div className="glass-card p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Invitation Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono tracking-widest text-center uppercase"
                placeholder="ST-XXXXXXXX"
                required
              />
            </div>

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
                placeholder="Min 8 chars, upper + lower + number"
                required
              />
              {strength && (
                <p className={`text-xs mt-1 ${strength.color}`}>
                  Strength: {strength.text}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-spike-text-dim mb-2 tracking-wide uppercase">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-spike-bg border border-spike-border rounded-lg px-4 py-3 text-spike-text placeholder:text-spike-text-muted focus:outline-none focus:border-spike-cyan focus:ring-1 focus:ring-spike-cyan/30 transition-all font-mono"
                placeholder="Re-enter password"
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
              disabled={loading || !code || !email || !password || !confirmPassword}
              className="w-full btn-gradient text-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating Account...' : 'Create Account'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <Link href="/login" className="text-spike-cyan text-sm hover:text-spike-cyan/80 transition-colors">
              Already have an account? Log in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
