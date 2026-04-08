import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';
import { AuthProvider } from '@/components/providers/AuthProvider';
import ServiceWorkerRegistration from '@/components/providers/ServiceWorkerRegistration';
import { ActivityHeartbeat } from '@/components/ActivityHeartbeat';

export const metadata: Metadata = {
  title: 'Spike Trades — Today\'s Spikes | AI Canadian Stock Analyst',
  description: 'The world\'s most accurate short-term AI stock market analyst for the Canadian market (TSX + TSXV). Real-time analysis, proprietary Spike Score, and daily Top 10 picks.',
  keywords: ['stocks', 'TSX', 'TSXV', 'Canadian', 'AI', 'trading', 'spike', 'momentum'],
  authors: [{ name: 'Spike Trades' }],
  icons: { icon: '/favicon.ico', apple: '/images/icon-192.png' },
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
        <AuthProvider>
          <ServiceWorkerRegistration />
          <ActivityHeartbeat />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
