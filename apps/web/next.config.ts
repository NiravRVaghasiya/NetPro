import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@netpro/core", "@netpro/db", "@netpro/ui"],
  reactStrictMode: true,
  // Arena's HTTPS reverse-proxy previews (development only).
  allowedDevOrigins: ["*.e2b.app"],
  output: "standalone",
  async headers() {
    return [
      {
        source: "/card/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
