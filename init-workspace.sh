#!/bin/bash

# Makinari Non-Interactive Workspace Initializer
# Specifically designed for Codespaces and automated agent environments.

set -e

# --- Configuration ---
INSTALL_DIR="$(pwd)"
REPO_MARKET_FIT="https://github.com/Uncodier/market-fit.git"
REPO_API="https://github.com/Uncodier/API.git"
REPO_WORKFLOWS="https://github.com/Uncodier/workflows.git"
REPO_DB_SCHEME="https://github.com/makinary/makinari-db-scheme.git"

PORT_MARKET_FIT="3000"
PORT_API="3001"
PORT_WORKFLOWS="3002"

URL_MARKET_FIT="http://localhost:$PORT_MARKET_FIT"
URL_API="http://localhost:$PORT_API"
URL_WORKFLOWS="http://localhost:$PORT_WORKFLOWS"

# Dummy keys for local development
DUMMY_OPENAI_KEY="sk-dummy-openai-key-for-local-dev"
DUMMY_SUPABASE_URL="http://localhost:54321"
DUMMY_SUPABASE_KEY="dummy-supabase-service-role-key"

CFG_TEMPORAL_HOST="localhost:7233"
CFG_TEMPORAL_NAMESPACE="default"

# --- Colors ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

echo -e "${BLUE}=======================================${NC}"
echo -e "${BLUE}   Makinari - Workspace Initializer    ${NC}"
echo -e "${BLUE}=======================================${NC}"

setup_repo() {
    local name=$1
    local url=$2
    local port=$3
    local dir="$INSTALL_DIR/$name"

    echo -e "\n${BLUE}--- Setting up $name ---${NC}"
    if [ ! -d "$dir" ]; then 
        log_info "Cloning $name..."
        GIT_TERMINAL_PROMPT=0 git clone "$url" "$dir"
    else 
        log_info "$name already exists. Pulling latest..."
        cd "$dir" && git pull && cd "$INSTALL_DIR"
    fi

    if [ -f "$dir/package.json" ]; then 
        log_info "Installing dependencies for $name..."
        cd "$dir" && npm install --silent && cd "$INSTALL_DIR"
    fi

    # Env Config
    local env_file="$dir/.env"
    if [ ! -f "$env_file" ]; then
        if [ -f "$dir/.env.example" ]; then 
            cp "$dir/.env.example" "$env_file"
        elif [ -f "$dir/env.example" ]; then 
            cp "$dir/env.example" "$env_file"
        else
            touch "$env_file"
        fi
    fi

    log_info "Configuring environment variables for $name..."
    
    # Injections (Cross-platform sed)
    sed_inplace "s|NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$DUMMY_SUPABASE_URL|g" "$env_file" || true
    sed_inplace "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$DUMMY_SUPABASE_KEY|g" "$env_file" || true
    sed_inplace "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=$DUMMY_OPENAI_KEY|g" "$env_file" || true
    
    # Temporal
    if grep -q "TEMPORAL_" "$env_file"; then
        sed_inplace "s|TEMPORAL_SERVER_URL=.*|TEMPORAL_SERVER_URL=$CFG_TEMPORAL_HOST|g" "$env_file" || true
        sed_inplace "s|TEMPORAL_NAMESPACE=.*|TEMPORAL_NAMESPACE=$CFG_TEMPORAL_NAMESPACE|g" "$env_file" || true
    else
        echo "TEMPORAL_SERVER_URL=$CFG_TEMPORAL_HOST" >> "$env_file"
        echo "TEMPORAL_NAMESPACE=$CFG_TEMPORAL_NAMESPACE" >> "$env_file"
    fi

    # Ports & URLs
    if grep -q "PORT=" "$env_file"; then 
        sed_inplace "s|PORT=.*|PORT=$port|g" "$env_file" || true
    else 
        echo "PORT=$port" >> "$env_file"
    fi
    
    if grep -q "NEXT_PUBLIC_API_URL=" "$env_file"; then 
        sed_inplace "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=$URL_API|g" "$env_file" || true
    fi
    
    if grep -q "NEXT_PUBLIC_APP_URL=" "$env_file"; then 
        sed_inplace "s|NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=$URL_MARKET_FIT|g" "$env_file" || true
    fi
    
    if grep -q "API_BASE_URL=" "$env_file"; then 
        sed_inplace "s|API_BASE_URL=.*|API_BASE_URL=$URL_API|g" "$env_file" || true
    fi

    log_success "$name setup complete."
}

# 1. Setup Node Repositories
setup_repo "market-fit" "$REPO_MARKET_FIT" "$PORT_MARKET_FIT"
setup_repo "API" "$REPO_API" "$PORT_API"
setup_repo "Workflows" "$REPO_WORKFLOWS" "$PORT_WORKFLOWS"

# 2. Setup Database Schema Repository
echo -e "\n${BLUE}--- Setting up Database Schema ---${NC}"
DB_DIR="$INSTALL_DIR/makinari-db-scheme"
if [ ! -d "$DB_DIR" ]; then 
    log_info "Cloning makinari-db-scheme..."
    GIT_TERMINAL_PROMPT=0 git clone "$REPO_DB_SCHEME" "$DB_DIR"
else 
    log_info "makinari-db-scheme already exists. Pulling latest..."
    cd "$DB_DIR" && git pull && cd "$INSTALL_DIR"
fi

log_success "Workspace initialization complete!"
echo -e "${GREEN}You can now start everything by running: ./start-workspace.sh${NC}"
