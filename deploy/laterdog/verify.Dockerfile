# Customize this image with the target repository's offline dependencies.
FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /workspace
CMD ["pnpm", "test"]
