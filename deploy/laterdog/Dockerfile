# The build stage runs on the builder's native platform (the bundle is platform-independent); only the small runtime stage
# is emulated when the target is linux/amd64 on an Apple Silicon machine, as Cloudflare Containers require.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm laterdog:build

FROM node:24-bookworm-slim
# sqlite3, openssl and curl serve the entrypoint's state backup/restore; see deploy/laterdog/entrypoint.sh.
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates openssh-client sqlite3 openssl curl && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/opt/pnpm
ENV PATH=/opt/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && pnpm add -g @openai/codex@0.154.0
WORKDIR /app
COPY --from=build /app/dist-server/laterdog ./laterdog
COPY deploy/laterdog/entrypoint.sh ./entrypoint.sh
RUN chmod 755 ./entrypoint.sh
ENV LATERDOG_DATA_DIR=/var/lib/laterdog LATERDOG_BIND=0.0.0.0 LATERDOG_PORT=9010 LATERDOG_PUBLISHING_HOST=remote
RUN mkdir -p /var/lib/laterdog && chown node:node /var/lib/laterdog
USER node
VOLUME /var/lib/laterdog
EXPOSE 9010
CMD ["./entrypoint.sh"]
