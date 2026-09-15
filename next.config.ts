import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Moved out of `experimental` in Next 15.5. Off for now: it rewrites route types on
  // every build, and the portals' routes are still being added phase by phase.
  typedRoutes: false,
  // No `eslint` key: Next 16 removed its built-in ESLint integration, so a build no
  // longer runs it at all. Linting stays what it already was here — an explicit quality
  // gate (`npm run lint`), run in its own CI job rather than as a build side effect.
  typescript: {
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'pino'],
};

export default nextConfig;
