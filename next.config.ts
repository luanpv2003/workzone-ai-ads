import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Run an extra dev instance in parallel (another session holds .next): NEXT_DIST_DIR=.next-xxx (deploy already excludes .next-*).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Docker image (Dockerfile sets NEXT_OUTPUT=standalone): a self-contained server.js with only the files it needs.
  // Plain `npm run build && npm start` keeps the normal output.
  ...(process.env.NEXT_OUTPUT === "standalone" && { output: "standalone" as const }),
  // PDF/Word/Excel parsing libraries for the Knowledge base: loaded via Node's require, not bundled.
  serverExternalPackages: ["unpdf", "mammoth", "jszip"],
  experimental: {
    // Creative image uploads (Meta allows up to 30MB) and Knowledge base documents go through Server Actions.
    serverActions: { bodySizeLimit: "31mb" },
  },
  // Conservative security headers for every response (no CSP: inline styles / scripts would need a careful audit first).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No framing by other sites (clickjacking, e.g. the OAuth consent page).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
