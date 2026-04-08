'use client';

import { useEffect } from 'react';

const HEARTBEAT_INTERVAL_MS = 60_000; // 60 seconds

/**
 * ActivityHeartbeat — fires POST /api/activity/heartbeat every 60s
 * while the tab is visible. Self-gates on /api/auth so unauthenticated
 * visitors do not ping. Silent failure: heartbeat errors never disrupt UX.
 */
export function ActivityHeartbeat() {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const sendBeat = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      fetch('/api/activity/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {
        /* silent fail */
      });
    };

    fetch('/api/auth', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.authenticated) return;
        sendBeat(); // immediate first beat
        const interval = setInterval(sendBeat, HEARTBEAT_INTERVAL_MS);
        const onVis = () => {
          if (document.visibilityState === 'visible') sendBeat();
        };
        document.addEventListener('visibilitychange', onVis);
        cleanup = () => {
          clearInterval(interval);
          document.removeEventListener('visibilitychange', onVis);
        };
      })
      .catch(() => {
        /* silent fail */
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return null;
}
