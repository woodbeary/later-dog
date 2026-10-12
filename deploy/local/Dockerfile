ARG BASE_IMAGE=ghcr.io/woodbeary/later-dog:latest
FROM ${BASE_IMAGE}
USER root
ARG ENGINES="@anthropic-ai/claude-code @openai/codex"
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
ARG GROK_VERSION=1.0.41
RUN if [ -n "$GROK_VERSION" ]; then \
      mkdir -p /tmp/grok-install \
      && curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install/install.sh \
      && HOME=/tmp/grok-install PATH="/tmp/grok-install/.grok/bin:$PATH" bash /tmp/grok-install/install.sh "$GROK_VERSION" \
      && install -m 0755 "$(readlink -f /tmp/grok-install/.grok/bin/grok)" /usr/local/bin/grok \
      && HOME=/tmp/grok-install grok --version | grep -qF "grok $GROK_VERSION " \
      && rm -rf /tmp/grok-install; \
    fi
USER dog
