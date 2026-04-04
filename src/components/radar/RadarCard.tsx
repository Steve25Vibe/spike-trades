'use client';

import { cn } from '@/lib/utils';
import RadarIcon from './RadarIcon';

interface RadarPickData {
  id: string;
  rank: number;
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string;
  priceAtScan: number;
  smartMoneyScore: number;
  catalystStrength: number;
  newsSentiment: number;
  technicalSetup: number;
  volumeSignals: number;
  sectorAlignment: number;
  rationale: string | null;
  topCatalyst: string | null;
  passedOpeningBell: boolean;
  passedSpikes: boolean;
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-spike-text-muted truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-spike-bg rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-radar-green" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-spike-text-dim">{value}</span>
    </div>
  );
}

export default function RadarCard({ pick }: { pick: RadarPickData }) {
  const rankClass = pick.rank === 1 ? 'rank-1' : pick.rank === 2 ? 'rank-2' : pick.rank === 3 ? 'rank-3' : 'rank-default';

  return (
    <div className="glass-card p-5 relative group transition-all">
      {/* Top glow for top 3 */}
      {pick.rank <= 3 && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-radar-green to-transparent rounded-t-2xl" />
      )}

      <div className="flex items-start gap-4">
        {/* Rank badge */}
        <div className={cn('rank-badge flex-shrink-0', rankClass)}>
          {pick.rank}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <a
              href={`https://finance.yahoo.com/quote/${pick.ticker}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`View ${pick.ticker} on Yahoo Finance`}
              className="text-lg font-bold text-spike-text hover:text-radar-green transition-colors"
            >
              {pick.ticker}
            </a>
            <span className="text-xs px-2 py-0.5 rounded-full bg-spike-border/50 text-spike-text-dim flex-shrink-0">
              {pick.exchange}
            </span>
            {pick.sector && pick.sector !== 'Unknown' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-spike-violet/10 text-spike-violet flex-shrink-0">
                {pick.sector}
              </span>
            )}
            <RadarIcon
              size={24}
              title={`Smart Money Score: ${pick.smartMoneyScore}`}
            />
          </div>
          <p className="text-sm text-spike-text-dim line-clamp-2">{pick.name}</p>

          {/* Price */}
          <div className="flex items-baseline gap-3 mt-2">
            <span className="text-2xl font-bold mono">${pick.priceAtScan.toFixed(2)}</span>
          </div>
        </div>

        {/* Score */}
        <div className="flex-shrink-0 text-center">
          <div className={cn(
            'w-16 h-16 rounded-xl flex items-center justify-center font-bold text-xl mono',
            pick.smartMoneyScore >= 80 ? 'bg-spike-green/15 text-spike-green border border-spike-green/30' :
            pick.smartMoneyScore >= 60 ? 'bg-spike-amber/15 text-spike-amber border border-spike-amber/30' :
            'bg-spike-red/15 text-spike-red border border-spike-red/30'
          )}>
            {pick.smartMoneyScore}
          </div>
          <p className="text-[10px] text-spike-text-muted mt-1 uppercase tracking-wider">Score</p>
        </div>
      </div>

      {/* Top Catalyst */}
      {pick.topCatalyst && (
        <div className="mt-4 p-3 bg-radar-green/5 border border-radar-green/20 rounded-lg">
          <div className="text-[10px] uppercase text-radar-green/60 mb-1">Top Catalyst</div>
          <div className="text-sm text-spike-text-dim">{pick.topCatalyst}</div>
        </div>
      )}

      {/* Score breakdown bars */}
      <div className="space-y-1.5 mt-4">
        <ScoreBar label="Catalyst" value={pick.catalystStrength} max={30} />
        <ScoreBar label="News" value={pick.newsSentiment} max={25} />
        <ScoreBar label="Technical" value={pick.technicalSetup} max={25} />
        <ScoreBar label="Volume" value={pick.volumeSignals} max={10} />
        <ScoreBar label="Sector" value={pick.sectorAlignment} max={10} />
      </div>

      {/* Pipeline status */}
      <div className="flex items-center gap-2 text-[10px] mt-3">
        <span className={pick.passedOpeningBell ? 'text-spike-amber' : 'text-spike-text-muted'}>
          {pick.passedOpeningBell ? '\u2713 Opening Bell' : '\u25CB Awaiting OB'}
        </span>
        <span className="text-spike-text-muted">&rarr;</span>
        <span className={pick.passedSpikes ? 'text-spike-cyan' : 'text-spike-text-muted'}>
          {pick.passedSpikes ? '\u2713 Today\'s Spikes' : '\u25CB Awaiting Spikes'}
        </span>
      </div>

      {/* Rationale */}
      {pick.rationale && (
        <div className="mt-3 pt-3 border-t border-spike-border">
          <div className="text-[10px] uppercase text-radar-green/50 mb-1">Why This Stock?</div>
          <p className="text-xs text-spike-text-dim leading-relaxed">{pick.rationale}</p>
        </div>
      )}
    </div>
  );
}
