'use client';

interface BellIconProps {
  size?: number;
  className?: string;
  title?: string;
}

export default function BellIcon({ size = 16, className = '', title }: BellIconProps) {
  return (
    <span className={`inline-block ${className}`} title={title}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="animate-bell-ring"
        style={{ transformOrigin: '50% 0%' }}
      >
        {/* Bell body */}
        <path
          d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
          stroke="#FFB800"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="#FFB800"
          fillOpacity="0.15"
        />
        {/* Clapper */}
        <path
          d="M13.73 21a2 2 0 0 1-3.46 0"
          stroke="#FFB800"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Sound waves left */}
        <path
          d="M2 8c0-1.5.5-3 1.5-4"
          stroke="#FFB800"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.4"
        />
        {/* Sound waves right */}
        <path
          d="M22 8c0-1.5-.5-3-1.5-4"
          stroke="#FFB800"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.4"
        />
      </svg>
    </span>
  );
}
