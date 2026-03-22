'use client';

import { useState, useEffect } from 'react';
import ResponsiveLayout from '@/components/layout/ResponsiveLayout';

interface Preferences {
  emailDailySpikes: boolean;
  emailSellReminders: boolean;
  emailDeviationAlerts: boolean;
}

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/user/preferences')
      .then((r) => r.json())
      .then((json) => { if (json.success) setPrefs(json.data); });
  }, []);

  const toggle = async (key: keyof Preferences) => {
    if (!prefs) return;
    const newVal = !prefs[key];
    setPrefs({ ...prefs, [key]: newVal });
    setSaving(true);
    try {
      await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: newVal }),
      });
    } catch { /* revert on error */ setPrefs({ ...prefs, [key]: !newVal }); }
    finally { setSaving(false); }
  };

  return (
    <ResponsiveLayout>
        <h2 className="text-2xl font-display font-bold text-spike-cyan tracking-wide mb-6">
          SETTINGS
        </h2>

        <div className="glass-card p-6 max-w-lg">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
            Email Notifications
          </h3>
          <p className="text-xs text-spike-text-muted mb-6">
            Choose which emails you receive from Spike Trades.
          </p>

          {prefs ? (
            <div className="space-y-4">
              {[
                { key: 'emailDailySpikes' as const, label: 'Daily Spikes Summary', desc: 'Receive the Top 20 picks every trading day' },
                { key: 'emailSellReminders' as const, label: 'Sell Reminders', desc: 'Get notified when your positions hit their target windows' },
                { key: 'emailDeviationAlerts' as const, label: 'Deviation Alerts', desc: 'Alert when positions move significantly against predictions' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between py-3 border-b border-spike-border/50">
                  <div>
                    <p className="text-sm text-spike-text font-medium">{label}</p>
                    <p className="text-xs text-spike-text-muted">{desc}</p>
                  </div>
                  <button
                    onClick={() => toggle(key)}
                    disabled={saving}
                    className={`relative w-11 h-6 rounded-full transition-colors ${prefs[key] ? 'bg-spike-cyan' : 'bg-spike-border'}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${prefs[key] ? 'translate-x-5' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-spike-text-muted text-sm">Loading preferences...</p>
          )}
        </div>

        <div className="legal-footer">
          <p className="mt-2">&copy; {new Date().getFullYear()} Spike Trades — spiketrades.ca &middot; Ver 2.1</p>
        </div>
    </ResponsiveLayout>
  );
}
