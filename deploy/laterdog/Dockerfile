FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun-runtime

FROM --platform=$BUILDPLATFORM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun-tool

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=bun-tool /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = 1.4.5
COPY package.json bun.lock bunfig.toml .bun-version ./
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
COPY scripts/check-package-manager.mjs ./scripts/check-package-manager.mjs
RUN bun install --frozen-lockfile --ignore-scripts --cpu=arm64 --cpu=x64
COPY . .
RUN bun run laterdog:build

FROM node:24-bookworm-slim
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = 1.4.5
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates openssh-client sqlite3 openssl curl tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm && npm install -g @openai/codex@0.154.0
WORKDIR /app
COPY --from=build /app/dist-server/laterdog ./laterdog
COPY deploy/laterdog/entrypoint.sh ./entrypoint.sh
RUN chmod 755 ./entrypoint.sh
ENV LATERDOG_DATA_DIR=/var/lib/laterdog LATERDOG_BIND=0.0.0.0 LATERDOG_PORT=9010 LATERDOG_PUBLISHING_HOST=remote
RUN mkdir -p /var/lib/laterdog && chown node:node /var/lib/laterdog
USER node
VOLUME /var/lib/laterdog
EXPOSE 9010
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
