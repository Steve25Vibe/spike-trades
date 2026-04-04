'use client';

interface RadarIconProps {
  size?: number;
  className?: string;
  title?: string;
}

export default function RadarIcon({ size = 16, className = '', title }: RadarIconProps) {
  return (
    <span className={`inline-block ${className}`} title={title}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Outer circle */}
        <circle cx="12" cy="12" r="10" stroke="#00FF41" strokeWidth="1.5" opacity="0.3" />
        {/* Middle circle */}
        <circle cx="12" cy="12" r="6" stroke="#00FF41" strokeWidth="1.5" opacity="0.5" />
        {/* Center dot */}
        <circle cx="12" cy="12" r="2" fill="#00FF41" />
        {/* Sweep line (animated) */}
        <line
          x1="12"
          y1="12"
          x2="12"
          y2="2"
          stroke="#00FF41"
          strokeWidth="2"
          strokeLinecap="round"
          className="origin-center animate-radar-sweep"
        />
        {/* Glow on sweep */}
        <path
          d="M12 12 L12 2 A10 10 0 0 1 21 8 Z"
          fill="#00FF41"
          opacity="0.1"
          className="origin-center animate-radar-sweep"
        />
      </svg>
    </span>
  );
}
