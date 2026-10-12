/**
 * Next.js config.
 *
 * Normal mode (Vercel): full app with the /api/register endpoint and /admin page.
 * Preview mode (UNIBEE_PREVIEW_EXPORT=1): a static, click-through preview of the
 * public pages. Built by `npm run preview:export`; the form simulates a submission.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const isPreviewExport = process.env.UNIBEE_PREVIEW_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)), // this folder is its own app
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    unoptimized: isPreviewExport,
  },
  ...(isPreviewExport
    ? { output: "export", trailingSlash: false }
    : {
        async headers() {
          return [
            {
              source: "/:path*",
              headers: [
                { key: "X-Content-Type-Options", value: "nosniff" },
                { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
                { key: "X-Frame-Options", value: "SAMEORIGIN" },
                { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
