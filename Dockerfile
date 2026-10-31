# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Build this checkout, including its root apps/ workspace and committed lockfile.
# The allowlisted context excludes credentials, runtime state and host dependencies.
COPY . .
# tsx and workspace TypeScript are runtime requirements; retain dev dependencies.
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm run build --workspace=apps/dna-client-browser

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY docker/*.mjs docker/entrypoint.sh /opt/dna-container/
RUN node --check /opt/dna-container/bridge.mjs
RUN node --check /opt/dna-container/preflight.mjs \
    && node --check /opt/dna-container/healthcheck.mjs \
    && node --check /opt/dna-container/ticker.mjs \
    && node --check /opt/dna-container/control.mjs
# A container port collision must fail, never kill a sibling in the VPN namespace.
RUN printf '#!/bin/sh\nexit 0\n' > /app/just/free-port.sh \
    && chmod 755 /app/just/free-port.sh \
    && mkdir -p /data /logs /auth && chmod 700 /auth && chown node:node /data /logs /auth \
    && touch /app/apps/dna-client-browser/fe/dist/index.html
ENV NODE_ENV=production DNA_ENV_FILE=none DNA_DATA_DIR=/data DNA_LOG_DIR=/logs
USER node
ENTRYPOINT ["/bin/sh", "/opt/dna-container/entrypoint.sh"]
CMD ["api"]
