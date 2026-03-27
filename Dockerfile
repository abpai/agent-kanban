# ── Builder ──────────────────────────────────────────────
FROM oven/bun:1 AS builder
WORKDIR /app

# Install root deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install UI deps and build
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY ui/ ui/
COPY src/ src/
COPY tsconfig.json ./
RUN cd ui && bun run build

# ── Runtime ──────────────────────────────────────────────
FROM oven/bun:1-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN HUSKY=0 bun install --frozen-lockfile --production

# src/ and ui/dist/ must be siblings (server resolves ui/dist relative to src/)
COPY --from=builder /app/src/ src/
COPY --from=builder /app/ui/dist/ ui/dist/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const res = await fetch('http://localhost:3000/api/health'); if (!res.ok) process.exit(1)"

CMD ["bun", "src/index.ts", "serve"]
