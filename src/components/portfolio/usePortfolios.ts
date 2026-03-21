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

export function setActivePortfolioId(id: string) {
  localStorage.setItem(ACTIVE_PORTFOLIO_KEY, id);
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
        setPortfolios(json.data);
        // If no active portfolio set, or current one no longer exists, default to first
        const storedId = getActivePortfolioId();
        const exists = json.data.some((p: PortfolioInfo) => p.id === storedId);
        if (exists && storedId) {
          setActiveId(storedId);
        } else if (json.data.length > 0) {
          setActiveId(json.data[0].id);
          setActivePortfolioId(json.data[0].id);
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
