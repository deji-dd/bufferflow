# Multi-stage optimized Bun Dockerfile for Bufferflow
FROM oven/bun:1.4.3 AS base
WORKDIR /app

# Full dependency tree (build-time)
FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build static frontend
FROM dependencies AS builder
WORKDIR /app
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
COPY src ./src
RUN bun run build

# Server-only runtime dependencies
FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Production runner
FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts

EXPOSE 3001

CMD ["bun", "run", "src/index.ts"]
