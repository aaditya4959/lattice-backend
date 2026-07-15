# ---------- Stage 1: Build ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (leverages Docker layer caching —
# this layer only rebuilds when package*.json changes, not on every code change)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ---------- Stage 2: Production ----------
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Only install production dependencies — keeps final image small
COPY package*.json ./
RUN npm ci --omit=dev

# Copy only the compiled output from the builder stage, not the full source
COPY --from=builder /app/dist ./dist

# Run as a non-root user — good security practice for production containers
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

CMD ["node", "dist/main.js"]