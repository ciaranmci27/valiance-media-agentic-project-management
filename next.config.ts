import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
// Relative imports: the config loads before the `@/` path alias exists.
import customNextConfig from "./src/custom/next.config";
import { mergeNextConfig } from "./src/lib/extensions/next-config";
import { noFramingHeaders } from "./src/lib/security/frame-headers";

// The source install (Valiance's own) is built inside the monorepo, where the
// app sits next to admin/ and website/. The public repo and every install have
// the app at the repo root with neither beside it. Settings > Updates treats a
// source build as the place releases come from, so it never tries to update
// itself even when PM_INSTALL_ROLE was not set. Builds run from the app folder.
const sourceLayout =
  existsSync(join(process.cwd(), "..", "admin", "package.json")) &&
  existsSync(join(process.cwd(), "..", "website", "package.json"));

// The migration files this build carries, as the migration runner names them
// (core files, then custom/...), so Settings > Updates can say whether the
// database has them all (src/lib/updates/database.ts).
function migrationNames(): string {
  const sql = (dir: string) => existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const core = join(process.cwd(), "supabase", "migrations");
  return [...sql(core), ...sql(join(core, "custom")).map((name) => `custom/${name}`)].join(",");
}

const coreNextConfig: NextConfig = {
  // Build-time: read by installRole() in src/lib/updates/connection.ts and by
  // src/lib/updates/database.ts.
  env: { PM_MIGRATIONS: migrationNames(), ...(sourceLayout ? { PM_SOURCE_LAYOUT: "1" } : {}) },

  // LAN/Tailscale hosts allowed to hit the dev server (e.g., phones on the same network).
  // 127.0.0.1 is here too: the server prints "Local: http://localhost:3000", but
  // localhost and 127.0.0.1 are different origins as far as this check is concerned,
  // so anything opened via the IP (browser typed it, an automated tool, etc.) got its
  // /_next/* asset requests blocked as cross-origin without this.
  allowedDevOrigins: ['127.0.0.1', '192.168.127.227', '100.79.77.23', 'valiance-vps', '100.92.204.26', '**.ts.net'],

  // The Connect AI consent screen and sign-in never load inside another site's frame.
  async headers() {
    return noFramingHeaders();
  },

  // Old addresses of the live agent room, removed in 2.0.7.
  async redirects() {
    return [
      // The live 3D agent room left the app in 2.0.7: old links land on the Agent page.
      { source: '/command', destination: '/agent', permanent: true },
      { source: '/agent/live', destination: '/agent', permanent: false },
      { source: '/live', destination: '/agent', permanent: false },
      // Core used to ship its logo and favicon files here, and emails and
      // invoices already sent link to them. The brand now lives in Settings >
      // Workspace > Brand: these send each old path to the current file.
      // Temporary, so the target can change when the brand does.
      { source: '/logos/logo-dark.png', destination: '/api/logo?variant=dark', permanent: false },
      { source: '/logos/logo.png', destination: '/api/logo', permanent: false },
      { source: '/logos/favicon.png', destination: '/api/logo?type=favicon', permanent: false },
      { source: '/favicon/:file*', destination: '/api/logo?type=favicon', permanent: false },
    ];
  },
};

// The install's own settings (src/custom/next.config.ts) merge over core's:
// redirects, rewrites and headers combine, arrays join, the rest it overrides.
const nextConfig = mergeNextConfig(coreNextConfig, customNextConfig);

export default nextConfig;
