import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Moved out of `experimental` in Next 15.5. Off for now: it rewrites route types on
  // every build, and the portals' routes are still being added phase by phase.
  typedRoutes: false,
  eslint: {
    // Linting is an explicit quality gate (`npm run lint`), not a build side effect.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'pino'],
};

export default nextConfig;
