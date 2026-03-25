'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn, isMarketOpen } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';

const navItems = [
  {
    href: '/dashboard',
    label: 'Today\'s Spikes',
    tooltip: 'View today\'s AI-selected stock picks',
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
    tooltip: 'Manage your locked-in positions and trades',
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
    tooltip: 'See how past predictions performed',
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
    tooltip: 'Browse previous daily reports',
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

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ open = true, onClose }: SidebarProps) {
  const pathname = usePathname();
  const [marketOpen, setMarketOpen] = useState(false);
  const { role, logout } = useAuth();

  useEffect(() => {
    setMarketOpen(isMarketOpen());
    const interval = setInterval(() => setMarketOpen(isMarketOpen()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleNavClick = () => {
    onClose?.();
  };

  return (
    <aside className={cn(
      'fixed left-0 top-0 h-full w-64 bg-spike-bg-light border-r border-spike-border z-50 flex flex-col',
      'transition-transform duration-300 ease-in-out',
      'lg:translate-x-0',
      open ? 'translate-x-0' : '-translate-x-full'
    )}>
      {/* Logo */}
      <div className="p-6 border-b border-spike-border">
        <Link href="/dashboard" className="flex items-center" title="Go to today's top stock picks" onClick={handleNavClick}>
          <Image
            src="/images/spike-logo.png"
            alt="Spike Trades"
            width={200}
            height={50}
            className="drop-shadow-[0_0_8px_rgba(124,252,0,0.25)]"
            priority
          />
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
              title={item.tooltip}
              onClick={handleNavClick}
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

        {/* Settings */}
        <Link
          href="/settings"
          title="Email notification preferences"
          onClick={handleNavClick}
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all',
            pathname === '/settings'
              ? 'bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20'
              : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg-hover'
          )}
        >
          <span className={cn(pathname === '/settings' ? 'text-spike-cyan' : 'text-spike-text-muted')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </span>
          Settings
        </Link>

        {/* Logout */}
        <button
          onClick={() => { onClose?.(); logout(); }}
          title="Log out"
          className="flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all text-spike-text-dim hover:text-spike-red hover:bg-spike-red/5 w-full text-left"
        >
          <span className="text-spike-text-muted">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </span>
          Logout
        </button>

        {/* Admin section */}
        {role === 'admin' && (
          <>
            <div className="pt-4 pb-1 px-4">
              <p className="text-[10px] text-spike-text-muted uppercase tracking-[0.15em] font-medium">
                Admin
              </p>
            </div>
            <Link
              href="/admin"
              title="Manage users, invitations, and activity"
              onClick={handleNavClick}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all',
                pathname === '/admin'
                  ? 'bg-spike-cyan/10 text-spike-cyan border border-spike-cyan/20'
                  : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg-hover'
              )}
            >
              <span className={cn(pathname === '/admin' ? 'text-spike-cyan' : 'text-spike-text-muted')}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </span>
              Admin Panel
            </Link>
          </>
        )}
      </nav>

      {/* Market status */}
      <div className="p-4 border-t border-spike-border space-y-3">
        <div className="flex items-center gap-2 text-xs text-spike-text-dim">
          <div className={marketOpen ? 'live-dot' : 'live-dot-closed'} />
          <span>{marketOpen ? 'Live — TSX Open' : 'Closed — TSX Closed'}</span>
        </div>
        <p className="text-[10px] text-spike-text-muted">
          Next analysis: 10:45 AST
        </p>
      </div>
    </aside>
  );
}
