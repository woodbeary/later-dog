ARG BASE_IMAGE=laterdog-cloud-home:latest
FROM --platform=$BUILDPLATFORM golang:1.27.4 AS work-folder-builder
ARG TARGETARCH
WORKDIR /src
COPY deploy/laterdog/work-folder-mount/ ./
RUN mkdir -p /out && ./build.sh /out/laterdog-work-folder-mount

FROM ${BASE_IMAGE}
COPY --from=work-folder-builder /out/laterdog-work-folder-mount /app/cloud/bin/laterdog-work-folder-mount
COPY deploy/laterdog/work-folder-mount/LICENSE.dependencies /app/cloud/bin/LICENSE.work-folder-mount
USER root
COPY deploy/laterdog/home/Caddyfile /app/cloud/Caddyfile
COPY deploy/laterdog/home/runtime/ /app/cloud/runtime/
COPY package.json /app/cloud/package.json
COPY deploy/laterdog/home/codex-requirements.toml /etc/codex/requirements.toml
ARG LATERDOG_BUILD=""
RUN if [ -n "$LATERDOG_BUILD" ]; then printf '%s\n' "$LATERDOG_BUILD" > /app/cloud/build; fi \
 && chown -R root:root /app/cloud \
 && chmod -R go-w /app/cloud \
 && chmod 0644 /app/cloud/runtime/archive-ownership.mjs \
 && su -s /bin/sh dog -c 'node --check /app/cloud/runtime/archive-ownership.mjs' \
 && LATERDOG_CLOUD_PUBLIC_HOST=validate-home.later.dog caddy validate --config /app/cloud/Caddyfile --adapter caddyfile \
 && node --check /app/cloud/runtime/run.mjs \
 && node --check /app/cloud/runtime/restore-until-done.mjs \
 && node --check /app/cloud/runtime/launcher-switch.mjs \
 && node --check /app/cloud/runtime/restore-signals.mjs \
 && node --check /app/cloud/runtime/dev-code.mjs \
 && node --check /app/cloud/runtime/archive.mjs \
 && node --input-type=module -e 'import { archiveCompatible } from "/app/cloud/runtime/archive-capability.mjs"; if (!await archiveCompatible("/app/dist-server/cloud-home-start.js", {workFolders:true})) throw new Error("home server lacks safe log restoration")' \
 && node --check /app/cloud/runtime/archive-launcher.mjs \
 && node --check /app/cloud/runtime/archive-capability.mjs \
 && node --check /app/cloud/runtime/archive-ownership.mjs \
 && node --check /app/cloud/runtime/work-folder-mounts.mjs \
 && node --check /app/cloud/runtime/sync.mjs \
 && node --check /app/cloud/runtime/save-status.mjs \
 && node --check /app/cloud/runtime/restore-points.mjs \
 && node --check /app/cloud/runtime/included.mjs \
 && /usr/bin/tini --version
ENV HOME=/data
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/cloud/runtime/run.mjs"]
