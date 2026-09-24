import type { NextConfig } from "next";

// A static export: every page is HTML at build time, so the site can live on
// GitHub Pages or any file host. KIKOE_SITE_BASE is the path it is served
// under ("/kikoe" on a project Pages site); empty for a domain of its own.
const base = process.env.KIKOE_SITE_BASE ?? "";

const config: NextConfig = {
  output: "export",
  basePath: base,
  trailingSlash: true,
  // No image server in a static export; the images are already WebP at the
  // sizes they are shown (scripts/images.mjs).
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE: base },
};

export default config;
