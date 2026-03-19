import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Spike Trades — Today\'s Spikes | AI Canadian Stock Analyst',
  description: 'The world\'s most accurate short-term AI stock market analyst for the Canadian market (TSX + TSXV). Real-time analysis, proprietary Spike Score, and daily Top 20 picks.',
  keywords: ['stocks', 'TSX', 'TSXV', 'Canadian', 'AI', 'trading', 'spike', 'momentum'],
  authors: [{ name: 'Spike Trades' }],
  icons: { icon: '/favicon.ico' },
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0A1428',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-spike-bg text-spike-text antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
