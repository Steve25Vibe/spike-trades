'use client';

import { useState, useCallback, ReactNode } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';

export default function ResponsiveLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="min-h-screen bg-spike-bg">
      <ParticleBackground />

      {/* Mobile top bar — visible below lg */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-spike-bg-light/95 backdrop-blur-sm border-b border-spike-border z-50 flex items-center px-4 lg:hidden">
        <button
          onClick={openSidebar}
          className="p-2 -ml-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-spike-text-dim hover:text-spike-cyan transition-colors"
          aria-label="Open menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="flex items-center gap-2 ml-3">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-spike-cyan to-spike-violet flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0A1428" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <span className="text-spike-cyan font-display font-bold tracking-wider text-sm">
            SPIKE TRADES
          </span>
        </div>
      </header>

      {/* Backdrop overlay on mobile when sidebar open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar — slides on mobile, fixed on desktop */}
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      {/* Main content — offset for mobile top bar + desktop sidebar */}
      <main className="pt-14 lg:pt-0 lg:ml-64 p-4 md:p-6 lg:p-8 relative z-10">
        {children}
      </main>
    </div>
  );
}
