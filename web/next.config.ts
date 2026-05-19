import type { NextConfig } from "next";

const apiBase = process.env.API_BASE_URL ?? `http://localhost:${process.env.SERVER_PORT ?? 51737}`;

const config: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: "/proxy",
  },
  async rewrites() {
    return [
      { source: "/proxy/:path*", destination: `${apiBase}/:path*` },
    ];
  },
};

export default config;
