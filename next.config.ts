import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Docker 이미지용: 실행에 필요한 파일만 .next/standalone에 모은다(node_modules 없이 server.js로 실행). 개발 서버에는 영향 없음.
  output: "standalone",
  // three/examples(addons)는 ESM 소스 그대로 배포되므로 트랜스파일 대상에 포함한다.
  transpilePackages: ["three"],
};

export default nextConfig;
