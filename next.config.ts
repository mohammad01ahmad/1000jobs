import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "puppeteer-extra", "puppeteer-extra-plugin-stealth"],
};

export default nextConfig;
