FROM caddy:2.10.2 AS edge
RUN cp /usr/bin/caddy /caddy

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.0
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:server && pnpm exec vite build && chmod -R go-w dist dist-server

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /data --shell /bin/bash dog
ARG AGENT_BROWSER_VERSION=0.37.0
ARG CHROME_CACHE_TAG=""
RUN echo "agent-browser ${AGENT_BROWSER_VERSION}, Chrome for Testing ${CHROME_CACHE_TAG:-Stable}" \
  && npm install -g --cache /tmp/npm-cache agent-browser@${AGENT_BROWSER_VERSION} \
  && HOME=/opt/laterdog-browser agent-browser install \
  && ln -s /opt/laterdog-browser/.agent-browser/browsers/chrome-*/chrome /opt/laterdog-browser/chrome \
  && native="$(readlink -f "$(command -v agent-browser)")" \
  && case "$native" in */agent-browser/bin/agent-browser-linux-*) ;; *) echo "agent-browser is not a native binary: $native" >&2; exit 1;; esac \
  && [ "$(head -c 4 "$native")" = "$(printf '\177ELF')" ] \
  && for binary in "${native%/*}"/agent-browser-*; do [ "$binary" = "$native" ] || rm "$binary"; done \
  && agent-browser --version \
  && rm -rf /tmp/npm-cache /tmp/node-compile-cache
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/laterdog-browser/chrome \
    LATERDOG_HOME=/data/.laterdog \
    LATERDOG_STATIC_DIR=/app/dist \
    LATERDOG_SERVER_PORT=8799 \
    LATERDOG_WEBHOOK_PORT=8800 \
    NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS cloud-home
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep gh jq \
  && rm -rf /var/lib/apt/lists/*
COPY --from=edge /caddy /usr/local/bin/caddy
ARG GROK_VERSION=1.0.41
RUN if [ -n "$GROK_VERSION" ]; then \
      mkdir -p /tmp/grok-install \
      && curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install/install.sh \
      && HOME=/tmp/grok-install PATH="/tmp/grok-install/.grok/bin:$PATH" bash /tmp/grok-install/install.sh "$GROK_VERSION" \
      && install -m 0755 "$(readlink -f /tmp/grok-install/.grok/bin/grok)" /usr/local/bin/grok \
      && HOME=/tmp/grok-install grok --version | grep -qF "grok $GROK_VERSION " \
      && rm -rf /tmp/grok-install; \
    fi
ARG CLOUD_HOME_ENGINES="@anthropic-ai/claude-code@2.1.301 @openai/codex@0.163.0"
ARG ENGINES_CACHE_TAG=""
RUN echo "engines: ${CLOUD_HOME_ENGINES:-none} ${ENGINES_CACHE_TAG}" \
  && if [ -n "$CLOUD_HOME_ENGINES" ]; then HOME=/tmp/laterdog-build-home npm install -g $CLOUD_HOME_ENGINES; fi \
  && rm -rf /tmp/laterdog-build-home /tmp/node-compile-cache
COPY deploy/cloud-home/Caddyfile /app/cloud/Caddyfile
COPY --from=build /src/dist-server ./dist-server
COPY --from=build /src/dist ./dist
RUN export HOME=/tmp/laterdog-build-home \
 && chmod go-w /app/cloud /app/cloud/Caddyfile \
 && caddy version \
 && LATERDOG_CLOUD_PUBLIC_HOST=validate.fly.dev caddy validate --config /app/cloud/Caddyfile --adapter caddyfile \
 && test -f /app/dist-server/cloud-home-start.js \
 && untrusted="$(find /app /usr/local/bin/caddy \( ! -user root -o ! -type l -perm /022 \) -print)" \
 && if [ -n "$untrusted" ]; then echo "not root's, or writable by others:" >&2; echo "$untrusted" >&2; exit 1; fi \
 && rm -rf /tmp/laterdog-build-home
ENV HOME=/data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -sf http://127.0.0.1:8080/api/health | grep -q laterdog || exit 1
USER root
CMD ["node", "/app/dist-server/cloud-home-start.js"]

FROM runtime AS server
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then HOME=/tmp/laterdog-build-home npm install -g $ENGINES && rm -rf /tmp/laterdog-build-home /tmp/node-compile-cache; fi
COPY --from=build --chown=dog:dog /src/dist-server ./dist-server
COPY --from=build --chown=dog:dog /src/dist ./dist
ENV HOME=/data
VOLUME ["/data"]
USER dog
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8799/api/health | grep -q laterdog || exit 1
CMD ["node", "dist-server/server-launcher.js"]
