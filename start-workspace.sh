#!/bin/bash

# Makinari Workspace Startup Script
# Designed for Codespaces, Linux, and Agent environments.

set -e

sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# Make sure we are in the workspace root
cd "$(dirname "$0")"

echo -e "\033[0;34m=======================================\033[0m"
echo -e "\033[0;34m   Makinari - Ecosystem Starter        \033[0m"
echo -e "\033[0;34m=======================================\033[0m"

# 1. Database (Supabase)
if [ -d "makinari-db-scheme" ]; then
    echo -e "\033[0;32m[INFO]\033[0m Starting Supabase (Database & Services)..."
    cd makinari-db-scheme
    supabase start
    supabase migration up || true
    
    # Extract actual Supabase URL and Key and inject them back if possible
    STATUS_OUTPUT=$(supabase status || true)
    if [ -n "$STATUS_OUTPUT" ]; then
        SUPA_URL=$(echo "$STATUS_OUTPUT" | grep "API URL" | awk '{print $4}' || true)
        SUPA_KEY=$(echo "$STATUS_OUTPUT" | grep "service_role key" | awk '{print $4}' || true)
        
        if [ -n "$SUPA_URL" ] && [ -n "$SUPA_KEY" ]; then
            echo "Updating .env files with actual local Supabase credentials..."
            cd ..
            for dir in market-fit API Workflows; do
                if [ -f "$dir/.env" ]; then
                    sed_inplace "s|NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$SUPA_URL|g" "$dir/.env" || true
                    sed_inplace "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$SUPA_KEY|g" "$dir/.env" || true
                fi
            done
        else
            cd ..
        fi
    else
        cd ..
    fi
else
    echo -e "\033[1;33m[WARN]\033[0m makinari-db-scheme directory not found. Supabase will not be started."
fi

echo ""
echo -e "\033[0;32m[INFO]\033[0m Launching Temporal and Node.js Services Concurrently..."

# 2. Start all long-running processes using concurrently
npx concurrently -k -p "[{name}]" -n "Temporal,MarketFit,API,Worker:Critical,Worker:Mail,Worker:Default" -c "cyan,green,blue,magenta,yellow,red" \
    "temporal server start-dev --ui-port 8080 --db-filename temporal.db" \
    "cd market-fit && npm run dev" \
    "cd API && npm run dev" \
    "cd Workflows && npm run start-worker -- --queue critical" \
    "cd Workflows && npm run start-worker -- --queue mail" \
    "cd Workflows && npm run start-worker -- --queue default"
