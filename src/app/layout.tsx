import type { Metadata, Viewport } from 'next';
import { Inter, Source_Serif_4 } from 'next/font/google';
import { brandAssets } from '@/lib/assets';
import './globals.css';

/**
 * Typography (CLAUDE.md §21): a premium editorial serif for display headings and a
 * neutral, highly legible sans for every operational surface. Both are self-hosted by
 * `next/font` so no third-party font URL is ever requested at runtime and there is no
 * layout shift on load.
 */
const displayFont = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-apron-display',
});

const sansFont = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-apron-sans',
});

export const metadata: Metadata = {
  title: {
    default: 'Apron — private aviation ground services',
    template: '%s · Apron',
  },
  description:
    'Apron coordinates private-aviation ground services: ground transport, close protection, hotel, catering, fuel and hangar, from one request.',
  applicationName: 'Apron',
  icons: {
    icon: [{ url: brandAssets.appIcon, type: 'image/svg+xml' }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0F2238',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${sansFont.variable}`}>
      <body className="min-h-screen bg-canvas text-text-primary antialiased">{children}</body>
    </html>
  );
}
