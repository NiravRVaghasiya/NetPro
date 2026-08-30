import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@netpro/core', '@netpro/db', '@netpro/ui'],
  reactStrictMode: true,
};

export default nextConfig;
