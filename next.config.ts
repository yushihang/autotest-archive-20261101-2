import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 运行期需要读写 artifacts/ 与 .data/，放在 src/ 之外即可，无需额外 webpack 配置。
  poweredByHeader: false,
};

export default nextConfig;
