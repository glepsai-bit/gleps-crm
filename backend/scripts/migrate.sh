#!/bin/bash
# ============================================
# GLEPS CRM - Database Migration Script
# ============================================

set -e

echo "=========================================="
echo "GLEPS CRM - Database Migration Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}❌ ERROR: DATABASE_URL not set${NC}"
    echo ""
    echo "Usage: DATABASE_URL=postgresql://user:pass@host:5432/db ./migrate.sh"
    echo ""
    echo "Or set it in your environment:"
    echo "  export DATABASE_URL=postgresql://user:pass@host:5432/db"
    echo ""
    exit 1
fi

# Extract host for connection check
DB_HOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\).*/\1/p')
echo -e "${YELLOW}📍 Database Host: ${DB_HOST}${NC}"
echo ""

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if npx prisma db execute --stdin <<< "SELECT 1" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Database connection established${NC}"
        break
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "   Attempt $RETRY_COUNT/$MAX_RETRIES - Database not ready, waiting..."
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}❌ ERROR: Could not connect to database after $MAX_RETRIES attempts${NC}"
    exit 1
fi

echo ""
echo "📦 Generating Prisma Client..."
npx prisma generate
echo -e "${GREEN}✅ Prisma Client generated${NC}"

echo ""
echo "🔄 Applying migrations..."
npx prisma migrate deploy
echo -e "${GREEN}✅ Migrations applied successfully!${NC}"

# Optional: run seed
if [ "$RUN_SEED" = "true" ]; then
    echo ""
    echo "🌱 Running database seed..."
    npx tsx src/prisma/seed.ts
    echo -e "${GREEN}✅ Seed completed!${NC}"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Database is ready!${NC}"
echo "=========================================="
