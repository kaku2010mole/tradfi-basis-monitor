import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/jlp-app/index.html",
      headers: [{ key: "Cache-Control", value: "private, no-store" }],
    }];
  },
};

export default nextConfig;
