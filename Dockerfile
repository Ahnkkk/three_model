# syntax=docker/dockerfile:1

# 인테리어 3D 뷰어(Next.js standalone) 실행 이미지
#   Docker Desktop:  docker compose up -d --build        → http://localhost:3000
#   직접 실행:        docker build -t interior-3d-viewer .
#                    docker run -d -p 3000:3000 --name interior-3d-viewer interior-3d-viewer
#
# 3D 렌더링은 모두 브라우저(WebGPU, 안 되면 WebGL 2)에서 하므로 컨테이너는 페이지와 정적 파일만 제공한다.

# glibc 기반(slim). package-lock.json에 들어 있는 리눅스용 네이티브 패키지(swc·lightningcss·tailwind oxide)를 그대로 쓴다.
ARG NODE_IMAGE=node:24-bookworm-slim

# 1) 의존성 설치 — package.json·package-lock.json이 바뀔 때만 다시 실행된다.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# postinstall(scripts/copy-decoders.mjs)이 three의 Draco 디코더를 public/decoders로 복사하므로 함께 넣는다.
COPY package.json package-lock.json ./
COPY scripts/copy-decoders.mjs ./scripts/
RUN npm ci

# 2) 빌드 — next.config.ts의 output: "standalone"으로 실행에 필요한 파일만 .next/standalone에 모은다.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/decoders는 빌드 컨텍스트에서 제외(.dockerignore)했으므로 설치된 three 버전에서 다시 복사한다.
RUN node scripts/copy-decoders.mjs && npm run build

# 3) 실행 — 소스·node_modules 없이 standalone 서버와 정적 파일만 담는다.
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
# Docker Desktop의 컨테이너 상태(healthy)에 표시된다. slim 이미지에 curl이 없으므로 node의 fetch로 확인한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
