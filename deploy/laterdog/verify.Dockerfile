FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun-tool
FROM node:24-bookworm-slim
COPY --from=bun-tool /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = 1.4.5
WORKDIR /workspace
CMD ["bun", "run", "test"]
