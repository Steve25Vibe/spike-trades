import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        spike: {
          bg: '#0A1428',
          'bg-light': '#0F1D35',
          'bg-card': '#111E33',
          'bg-hover': '#162847',
          cyan: '#00F0FF',
          'cyan-dim': '#00B8C5',
          violet: '#A855F7',
          'violet-dim': '#7C3AED',
          green: '#00FF88',
          red: '#FF3366',
          amber: '#FFB800',
          gold: '#FFD700',
          border: '#1E3A5F',
          'border-light': '#2A4A6F',
          text: '#E2E8F0',
          'text-dim': '#94A3B8',
          'text-muted': '#64748B',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        display: ['Orbitron', 'sans-serif'],
      },
      backgroundImage: {
        'spike-gradient': 'linear-gradient(135deg, #0A1428 0%, #0F1D35 50%, #1A0A2E 100%)',
        'card-gradient': 'linear-gradient(145deg, rgba(17,30,51,0.8) 0%, rgba(15,29,53,0.4) 100%)',
        'cyan-glow': 'radial-gradient(circle, rgba(0,240,255,0.15) 0%, transparent 70%)',
        'violet-glow': 'radial-gradient(circle, rgba(168,85,247,0.15) 0%, transparent 70%)',
      },
      boxShadow: {
        'spike-cyan': '0 0 20px rgba(0,240,255,0.3), 0 0 60px rgba(0,240,255,0.1)',
        'spike-violet': '0 0 20px rgba(168,85,247,0.3), 0 0 60px rgba(168,85,247,0.1)',
        'spike-green': '0 0 15px rgba(0,255,136,0.3)',
        'spike-red': '0 0 15px rgba(255,51,102,0.3)',
        'card': '0 4px 30px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
      },
      animation: {
        'pulse-cyan': 'pulseCyan 2s ease-in-out infinite',
        'glow': 'glow 3s ease-in-out infinite alternate',
        'slide-up': 'slideUp 0.5s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        'score-fill': 'scoreFill 1.5s ease-out forwards',
      },
      keyframes: {
        pulseCyan: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(0,240,255,0.3)' },
          '50%': { boxShadow: '0 0 40px rgba(0,240,255,0.6)' },
        },
        glow: {
          '0%': { opacity: '0.5' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scoreFill: {
          '0%': { width: '0%' },
          '100%': { width: 'var(--score-width)' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
