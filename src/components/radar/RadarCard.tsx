'use client';

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

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 text-gray-400 truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-8 text-right text-gray-500">{value}</span>
    </div>
  );
}

export default function RadarCard({ pick }: { pick: RadarPickData }) {
  const scoreColor = pick.smartMoneyScore >= 80 ? '#00FF41' : pick.smartMoneyScore >= 60 ? '#FFB800' : '#FF6B6B';

  return (
    <div className="relative bg-gray-900/80 border border-gray-800 rounded-xl p-4 hover:border-radar-green/40 transition-colors">
      {/* Rank badge */}
      <div className={`absolute -top-2 -left-2 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
        pick.rank === 1 ? 'bg-radar-green/20 text-radar-green border border-radar-green/50' :
        pick.rank <= 3 ? 'bg-gray-800 text-radar-green/80 border border-radar-green/30' :
        'bg-gray-800 text-gray-400 border border-gray-700'
      }`}>
        {pick.rank}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <RadarIcon size={18} />
          <a
            href={`https://finance.yahoo.com/quote/${pick.ticker}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-radar-green font-bold text-lg hover:underline"
          >
            {pick.ticker}
          </a>
          <span className="text-gray-500 text-xs">{pick.name}</span>
        </div>
        {/* Score circle */}
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold border-2"
          style={{ borderColor: scoreColor, color: scoreColor }}
        >
          {pick.smartMoneyScore}
        </div>
      </div>

      {/* Price + exchange/sector pills */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-radar-green font-mono text-xl">${pick.priceAtScan.toFixed(2)}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{pick.exchange}</span>
        {pick.sector && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-900/30 text-violet-400">{pick.sector}</span>
        )}
      </div>

      {/* Top Catalyst */}
      {pick.topCatalyst && (
        <div className="mb-3 p-2 bg-radar-green/5 border border-radar-green/20 rounded-lg">
          <div className="text-[10px] uppercase text-radar-green/60 mb-1">Top Catalyst</div>
          <div className="text-sm text-gray-200">{pick.topCatalyst}</div>
        </div>
      )}

      {/* Score breakdown bars */}
      <div className="space-y-1.5 mb-3">
        <ScoreBar label="Catalyst" value={pick.catalystStrength} max={30} color="#00FF41" />
        <ScoreBar label="News" value={pick.newsSentiment} max={25} color="#00FF41" />
        <ScoreBar label="Technical" value={pick.technicalSetup} max={25} color="#00FF41" />
        <ScoreBar label="Volume" value={pick.volumeSignals} max={10} color="#00FF41" />
        <ScoreBar label="Sector" value={pick.sectorAlignment} max={10} color="#00FF41" />
      </div>

      {/* Pipeline status */}
      <div className="flex items-center gap-2 text-[10px] mb-2">
        <span className={pick.passedOpeningBell ? 'text-amber-400' : 'text-gray-600'}>
          {pick.passedOpeningBell ? '\u2713 Opening Bell' : '\u25CB Awaiting OB'}
        </span>
        <span className="text-gray-700">&rarr;</span>
        <span className={pick.passedSpikes ? 'text-cyan-400' : 'text-gray-600'}>
          {pick.passedSpikes ? '\u2713 Today\'s Spikes' : '\u25CB Awaiting Spikes'}
        </span>
      </div>

      {/* Rationale */}
      {pick.rationale && (
        <div className="mt-2 pt-2 border-t border-gray-800">
          <div className="text-[10px] uppercase text-radar-green/50 mb-1">Why This Stock?</div>
          <p className="text-xs text-gray-400 leading-relaxed">{pick.rationale}</p>
        </div>
      )}
    </div>
  );
}
