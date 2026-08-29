# Multi-stage optimized Bun Dockerfile for Bufferflow
FROM oven/bun:latest AS base
WORKDIR /app

# Install dependencies
FROM base AS dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Production runner
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3001/api/traffic/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
