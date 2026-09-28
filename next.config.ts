import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // GH Pages hosts the site at /bwp-analytics-dashboard/ — basePath is set in
  // the GH Actions deploy job (NEXT_PUBLIC_BASE_PATH env var). Local dev keeps
  // basePath empty so the dev server serves at /.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
