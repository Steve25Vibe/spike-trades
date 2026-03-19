'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn, isMarketOpen } from '@/lib/utils';

const navItems = [
  {
    href: '/dashboard',
    label: 'Today\'s Spikes',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
        <polyline points="16 7 22 7 22 13" />
      </svg>
    ),
  },
  {
    href: '/portfolio',
    label: 'Portfolio',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </svg>
    ),
  },
  {
    href: '/accuracy',
    label: 'Accuracy',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    ),
  },
  {
    href: '/reports',
    label: 'Archives',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [marketOpen, setMarketOpen] = useState(false);

  useEffect(() => {
    setMarketOpen(isMarketOpen());
    const interval = setInterval(() => setMarketOpen(isMarketOpen()), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-spike-bg-light border-r border-spike-border z-40 flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-spike-border">
        <Link href="/dashboard" className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-spike-cyan to-spike-violet flex items-center justify-center flex-shrink-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0A1428" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-display font-bold tracking-wider text-spike-cyan">
              SPIKE TRADES
            </h1>
            <p className="text-[10px] text-spike-text-muted tracking-[0.2em] uppercase -mt-0.5">
              Today&apos;s Spikes
            </p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all',
                isActive
                  ? 'bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20'
                  : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg-hover'
              )}
            >
              <span className={cn(isActive ? 'text-spike-cyan' : 'text-spike-text-muted')}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Market status */}
      <div className="p-4 border-t border-spike-border">
        <div className="flex items-center gap-2 text-xs text-spike-text-dim">
          <div className={marketOpen ? 'live-dot' : 'live-dot-closed'} />
          <span>{marketOpen ? 'Live — TSX Open' : 'Closed — TSX Closed'}</span>
        </div>
        <p className="text-[10px] text-spike-text-muted mt-2">
          Next analysis: 10:45 AST
        </p>
      </div>
    </aside>
  );
}
