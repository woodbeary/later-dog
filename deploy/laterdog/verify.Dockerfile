FROM oven/bun:1.4.5 AS bun-tool
FROM node:24-bookworm-slim
COPY --from=bun-tool /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(bun --version)" = 1.4.5
WORKDIR /workspace
CMD ["bun", "run", "test"]
