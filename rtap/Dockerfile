# Multi-stage reproducible container build for RTAP Production MVP
# Base: Node 22 Bookworm Slim
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install dependencies needed for compiling TypeScript
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source code and demo scripts
COPY src ./src
COPY demo ./demo

# Compile TypeScript to dist/
RUN npm run build

# -------------------------------------------------------------
# Runtime Image
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

# Install system dependencies:
# - ca-certificates: TLS verification for outgoing requests
# - curl: container health checks
# - git, python3: required by Promptfoo runtime plugins
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install pinned Promptfoo runtime (0.122.0) into /opt/promptfoo-runtime
WORKDIR /opt/promptfoo-runtime
COPY m0/promptfoo-runtime/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

WORKDIR /app

# Install production dependencies for RTAP control plane
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist

# Copy runtime assets, target configurations, and JSON schemas
COPY dashboard ./dashboard
COPY demo ./demo
COPY schemas ./schemas

# Create writable runtime directories:
# - /app/runs: SQLite databases, probe configs, and generated reports
# - /home/node/.promptfoo: Promptfoo evaluation cache directory
RUN mkdir -p /app/runs /home/node/.promptfoo && \
    chown -R node:node /app /opt/promptfoo-runtime /home/node

# Run as non-privileged node user
USER node

# Environment defaults
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    RTAP_DATA_DIR=/app/runs \
    PROMPTFOO_ENTRY=/opt/promptfoo-runtime/node_modules/promptfoo/dist/src/main.js \
    PROMPTFOO_DISABLE_TELEMETRY=1 \
    PROMPTFOO_DISABLE_UPDATE=1 \
    PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=true \
    PROMPTFOO_DISABLE_SHARING=true \
    HOME=/home/node

VOLUME ["/app/runs"]

EXPOSE 3000

# Healthcheck to verify system endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:3000/api/system/status || exit 1

CMD ["node", "dist/server/server.js"]
