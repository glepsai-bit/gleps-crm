# ============================================
# GLEPS CRM Backend - Dockerfile
# ============================================

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# ============================================
# Production stage
# ============================================
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files and install production dependencies
COPY package*.json ./
COPY prisma ./prisma/

RUN npm install --omit=dev && \
    npx prisma generate

# Copy startup script
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x scripts/start.sh

# Copy built application
COPY --from=builder /app/dist ./dist

# Change ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check (start_period alto para dar tempo de migrations + seed)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD wget --spider -q http://localhost:3000/api/health || exit 1

# Start via script (aguarda banco, roda migrations, seed, depois inicia)
CMD ["sh", "scripts/start.sh"]
