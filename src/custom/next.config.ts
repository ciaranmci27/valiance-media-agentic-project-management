import type { NextConfig } from 'next';

/**
 * This install's Next.js settings, merged over core's in next.config.ts:
 * redirects, rewrites and headers run alongside core's, arrays (such as
 * images.remotePatterns) add to core's, and any other key overrides it.
 *
 * Import nothing through `@/` here: the config loads before the alias exists.
 *
 * Example:
 *   images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.example.com' }] },
 *   async redirects() {
 *     return [{ source: '/old-report', destination: '/x/reports', permanent: true }];
 *   },
 */
const config: NextConfig = {};

export default config;
