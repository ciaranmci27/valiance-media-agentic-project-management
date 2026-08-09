import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LAN/Tailscale hosts allowed to hit the dev server (e.g., phones on the same network).
  // 127.0.0.1 is here too: the server prints "Local: http://localhost:3000", but
  // localhost and 127.0.0.1 are different origins as far as this check is concerned,
  // so anything opened via the IP (browser typed it, an automated tool, etc.) got its
  // /_next/* asset requests blocked as cross-origin without this.
  allowedDevOrigins: ['127.0.0.1', '192.168.127.227', '100.79.77.23', '**.ts.net'],

  // The live floor used to live at /command, which named the screen after
  // nothing in the product. Permanent because the new path is the real one and
  // the old name isn't coming back; the scene itself is unchanged.
  async redirects() {
    return [{ source: '/command', destination: '/agent/live', permanent: true }];
  },
};

export default nextConfig;
