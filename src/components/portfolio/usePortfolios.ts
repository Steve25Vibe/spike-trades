'use client';

import { useState, useEffect, useCallback } from 'react';

export interface PortfolioInfo {
  id: string;
  name: string;
  createdAt: string;
  sizingMode: string;
  portfolioSize: number;
  fixedAmount: number;
  kellyMaxPct: number;
  kellyWinRate: number;
  totalPositions: number;
  activePositions: number;
  totalInvested: number;
}

const ACTIVE_PORTFOLIO_KEY = 'spike-active-portfolio-id';

export function getActivePortfolioId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_PORTFOLIO_KEY);
}

export function setActivePortfolioId(id: string | null) {
  if (id) {
    localStorage.setItem(ACTIVE_PORTFOLIO_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_PORTFOLIO_KEY);
  }
}

export function usePortfolios() {
  const [portfolios, setPortfolios] = useState<PortfolioInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPortfolios = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolios');
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        const list: PortfolioInfo[] = json.data;
        setPortfolios(list);

        // Resolve active portfolio
        const storedId = getActivePortfolioId();
        const exists = list.some((p) => p.id === storedId);

        if (exists && storedId) {
          setActiveId(storedId);
        } else if (list.length > 0) {
          // Stored one was deleted or never set — pick first
          setActiveId(list[0].id);
          setActivePortfolioId(list[0].id);
        } else {
          // No portfolios at all
          setActiveId(null);
          setActivePortfolioId(null);
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchPortfolios(); }, [fetchPortfolios]);

  const selectPortfolio = (id: string) => {
    setActiveId(id);
    setActivePortfolioId(id);
  };

  const activePortfolio = portfolios.find((p) => p.id === activeId) || null;

  return { portfolios, activeId, activePortfolio, loading, selectPortfolio, refresh: fetchPortfolios };
}
