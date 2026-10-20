ARG BASE_IMAGE=laterdog-cloud-home:latest
FROM ${BASE_IMAGE}
USER root
COPY deploy/laterdog/home/Caddyfile /app/cloud/Caddyfile
COPY deploy/laterdog/home/runtime/ /app/cloud/runtime/
COPY package.json /app/cloud/package.json
ARG LATERDOG_BUILD=""
RUN if [ -n "$LATERDOG_BUILD" ]; then printf '%s\n' "$LATERDOG_BUILD" > /app/cloud/build; fi \
 && chown -R root:root /app/cloud \
 && chmod -R go-w /app/cloud \
 && LATERDOG_CLOUD_PUBLIC_HOST=validate-home.later.dog caddy validate --config /app/cloud/Caddyfile --adapter caddyfile \
 && node --check /app/cloud/runtime/run.mjs \
 && node --check /app/cloud/runtime/sync.mjs \
 && node --check /app/cloud/runtime/restore-points.mjs \
 && node --check /app/cloud/runtime/included.mjs \
 && /usr/bin/tini --version
ENV HOME=/data
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/cloud/runtime/run.mjs"]
