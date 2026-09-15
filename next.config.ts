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
  // Native or dynamically-loading packages that must stay outside the server bundle.
  // `argon2` is here explicitly rather than relying on Next's own detection: the same
  // package broke the worker bundle by being left in, and password hashing is not a thing
  // to discover is broken at the first sign-in.
  serverExternalPackages: ['argon2', 'pg', 'bullmq', 'ioredis', 'pino'],
};

export default nextConfig;
