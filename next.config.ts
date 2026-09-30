import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  // Build-time facts discovered by scripts/vercel-build.ts (see src/lib/dbUrl.ts).
  // Only the pooler HOST and a status code are inlined — never credentials.
  env: {
    ISO_DB_POOLER_HOST: process.env.ISO_DB_POOLER_HOST ?? "",
    ISO_DB_SETUP_STATUS: process.env.ISO_DB_SETUP_STATUS ?? "",
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
