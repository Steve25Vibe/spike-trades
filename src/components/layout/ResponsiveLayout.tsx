'use client';

import { useState, useCallback, useEffect, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import ParticleBackground from '@/components/layout/ParticleBackground';

const SCROLL_KEY = 'spike-scroll-positions';

function saveScrollPosition(path: string) {
  try {
    const positions = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
    positions[path] = window.scrollY;
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(positions));
  } catch { /* sessionStorage unavailable */ }
}

function restoreScrollPosition(path: string) {
  try {
    const positions = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
    const y = positions[path];
    if (y != null && y > 0) {
      // Wait for content to render before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo(0, y);
        });
      });
    }
  } catch { /* sessionStorage unavailable */ }
}

export default function ResponsiveLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Save scroll position before navigating away
  useEffect(() => {
    const handleBeforeNav = () => {
      saveScrollPosition(pathname);
    };

    // Listen for clicks on links that will trigger navigation
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest('a');
      if (anchor && anchor.href && !anchor.target) {
        saveScrollPosition(pathname);
      }
    };

    // Also save on popstate (back/forward buttons)
    window.addEventListener('click', handleClick, true);
    window.addEventListener('beforeunload', handleBeforeNav);

    return () => {
      window.removeEventListener('click', handleClick, true);
      window.removeEventListener('beforeunload', handleBeforeNav);
    };
  }, [pathname]);

  // Restore scroll position when arriving at a page
  useEffect(() => {
    // Small delay to ensure data has loaded and content rendered
    const timer = setTimeout(() => {
      restoreScrollPosition(pathname);
    }, 150);

    return () => clearTimeout(timer);
  }, [pathname]);

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
