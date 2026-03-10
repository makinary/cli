#!/bin/bash

# Makinari Interactive Installer (Wizard) v4
# Installs and configures Market Fit, API, Workflows, Database, and Temporal
# Generates a 'start-dev.sh' for one-command startup.

set -e

# --- Configuration ---
INSTALL_DIR="$(pwd)"
REPO_MARKET_FIT="https://github.com/Uncodier/market-fit.git"
REPO_API="https://github.com/Uncodier/API.git"
REPO_WORKFLOWS="https://github.com/Uncodier/workflows.git"
REPO_DB_SCHEME="https://github.com/Uncodier/makinari-db-scheme.git"

# --- Default Ports ---
PORT_MARKET_FIT="3000"
PORT_API="3001"
PORT_WORKFLOWS="3002"

# --- Colors ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# --- Helper Functions ---

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

prompt_input() {
    local prompt_text=$1
    local default_val=$2
    local var_name=$3
    
    if [ -n "$default_val" ]; then
        read -p "$(echo -e "${GREEN}? ${prompt_text} [${default_val}]: ${NC}")" input_val
        if [ -z "$input_val" ]; then
            eval $var_name=\"$default_val\"
        else
            eval $var_name=\"$input_val\"
        fi
    else
        read -p "$(echo -e "${GREEN}? ${prompt_text}: ${NC}")" input_val
        eval $var_name=\"$input_val\"
    fi
}

prompt_secret() {
    local prompt_text=$1
    local var_name=$2
    read -s -p "$(echo -e "${GREEN}? ${prompt_text}: ${NC}")" input_val
    echo "" # New line after secret input
    eval $var_name=\"$input_val\"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# --- Checkers & Installers ---

check_and_install_docker() {
    log_info "Checking Docker..."
    if command_exists docker; then
        log_success "Docker is installed."
    else
        log_warn "Docker is not installed."
        if [[ "$OSTYPE" == "darwin"* ]] && command_exists brew; then
            prompt_input "Install Docker via Homebrew? (y/n)" "y" INSTALL_DOCKER
            if [ "$INSTALL_DOCKER" == "y" ]; then
                log_info "Installing Docker Desktop..."
                brew install --cask docker
                open -a Docker
            else
                log_error "Docker is required. Exiting."
                exit 1
            fi
        else
            log_error "Please install Docker manually."
            exit 1
        fi
    fi

    log_info "Checking Docker Daemon..."
    if ! docker info > /dev/null 2>&1; then
        log_warn "Docker not running. Starting..."
        if [[ "$OSTYPE" == "darwin"* ]]; then open -a Docker; fi
        log_info "Waiting for Docker..."
        while ! docker info > /dev/null 2>&1; do echo -n "."; sleep 2; done
        echo ""
        log_success "Docker is running!"
    fi
}

check_and_install_supabase() {
    log_info "Checking Supabase CLI..."
    if ! command_exists supabase; then
        if [[ "$OSTYPE" == "darwin"* ]] && command_exists brew; then
             log_info "Installing Supabase CLI..."
             brew install supabase/tap/supabase
        else
             log_error "Install Supabase CLI manually."
             exit 1
        fi
    fi
    log_success "Supabase CLI ready."
}

check_and_install_temporal() {
    log_info "Checking Temporal CLI..."
    if ! command_exists temporal; then
        if [[ "$OSTYPE" == "darwin"* ]] && command_exists brew; then
             log_info "Installing Temporal CLI..."
             brew install temporal
        else
             log_warn "Temporal CLI not found. Manual install required for local dev."
        fi
    fi
    log_success "Temporal CLI ready."
}

# --- Main Script ---

clear
echo -e "${BLUE}=======================================${NC}"
echo -e "${BLUE}   Makinari - Ecosystem Installer      ${NC}"
echo -e "${BLUE}=======================================${NC}"
echo "Installing to: $INSTALL_DIR"
echo ""

# 1. Prerequisites
check_and_install_docker
check_and_install_supabase
# Temporal check happens only if local is selected

# 2. Config Services
log_info "--- Service Ports ---"
prompt_input "Market Fit (Frontend)" "$PORT_MARKET_FIT" CFG_PORT_MARKET_FIT
prompt_input "API Server" "$PORT_API" CFG_PORT_API
prompt_input "Workflows" "$PORT_WORKFLOWS" CFG_PORT_WORKFLOWS

URL_MARKET_FIT="http://localhost:$CFG_PORT_MARKET_FIT"
URL_API="http://localhost:$CFG_PORT_API"
URL_WORKFLOWS="http://localhost:$CFG_PORT_WORKFLOWS"

# 3. Config Database
echo ""
log_info "--- Database Configuration ---"
prompt_input "Use Local Supabase? (y/n)" "y" USE_LOCAL_SUPABASE

CFG_SUPABASE_URL=""
CFG_SUPABASE_KEY=""

if [ "$USE_LOCAL_SUPABASE" == "y" ]; then
    log_info "Setting up Local Database..."
    if [ ! -d "makinari-db-scheme" ]; then
         git clone "$REPO_DB_SCHEME" makinari-db-scheme
    else
         cd makinari-db-scheme && git pull && cd ..
    fi
    
    cd makinari-db-scheme
    supabase start
    STATUS_OUTPUT=$(supabase status)
    CFG_SUPABASE_URL=$(echo "$STATUS_OUTPUT" | grep "API URL" | awk '{print $4}')
    CFG_SUPABASE_KEY=$(echo "$STATUS_OUTPUT" | grep "service_role key" | awk '{print $4}')
    cd ..
else
    prompt_input "Supabase URL" "" CFG_SUPABASE_URL
    prompt_secret "Supabase Service Role Key" CFG_SUPABASE_KEY
fi

# 4. Config Temporal
echo ""
log_info "--- Temporal Configuration ---"
prompt_input "Use Local Temporal Server? (y/n)" "y" USE_LOCAL_TEMPORAL

CFG_TEMPORAL_HOST="localhost:7233"
CFG_TEMPORAL_NAMESPACE="default"
CFG_TEMPORAL_CERT=""
CFG_TEMPORAL_KEY=""

if [ "$USE_LOCAL_TEMPORAL" == "y" ]; then
    check_and_install_temporal
    log_info "Local Temporal will run on localhost:7233"
else
    prompt_input "Temporal Host (e.g., cloud.temporal.io:7233)" "" CFG_TEMPORAL_HOST
    prompt_input "Temporal Namespace" "default" CFG_TEMPORAL_NAMESPACE
    prompt_input "Path to Client Cert (optional)" "" CFG_TEMPORAL_CERT
    prompt_input "Path to Client Key (optional)" "" CFG_TEMPORAL_KEY
fi

# 5. Config AI
echo ""
log_info "--- AI Keys (Optional) ---"
prompt_secret "OpenAI API Key" CFG_OPENAI_KEY
prompt_secret "Anthropic API Key" CFG_ANTHROPIC_KEY
prompt_secret "Gemini API Key" CFG_GEMINI_KEY

# 6. Setup Repos & Env
setup_repo() {
    local name=$1
    local url=$2
    local port=$3
    local dir="$INSTALL_DIR/$name"

    echo -e "\n${BLUE}--- Setting up $name ---${NC}"
    if [ ! -d "$dir" ]; then git clone "$url" "$dir"; else cd "$dir"; git pull; cd ..; fi
    if [ -f "$dir/package.json" ]; then cd "$dir"; npm install --silent; cd ..; fi

    # Env Config
    local env_file="$dir/.env"
    if [ -f "$dir/.env.example" ]; then cp "$dir/.env.example" "$env_file"; 
    elif [ -f "$dir/env.example" ]; then cp "$dir/env.example" "$env_file"; fi

    # Injections
    # Common
    if [ -n "$CFG_SUPABASE_URL" ]; then sed -i '' "s|NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$CFG_SUPABASE_URL|g" "$env_file"; fi
    if [ -n "$CFG_SUPABASE_KEY" ]; then sed -i '' "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$CFG_SUPABASE_KEY|g" "$env_file"; fi
    if [ -n "$CFG_OPENAI_KEY" ]; then sed -i '' "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=$CFG_OPENAI_KEY|g" "$env_file"; fi
    
    # Temporal
    if grep -q "TEMPORAL_" "$env_file"; then
        sed -i '' "s|TEMPORAL_SERVER_URL=.*|TEMPORAL_SERVER_URL=$CFG_TEMPORAL_HOST|g" "$env_file"
        sed -i '' "s|TEMPORAL_NAMESPACE=.*|TEMPORAL_NAMESPACE=$CFG_TEMPORAL_NAMESPACE|g" "$env_file"
    else
        echo "TEMPORAL_SERVER_URL=$CFG_TEMPORAL_HOST" >> "$env_file"
        echo "TEMPORAL_NAMESPACE=$CFG_TEMPORAL_NAMESPACE" >> "$env_file"
    fi

    # Ports & URLs
    if grep -q "PORT=" "$env_file"; then sed -i '' "s|PORT=.*|PORT=$port|g" "$env_file"; else echo "PORT=$port" >> "$env_file"; fi
    if grep -q "NEXT_PUBLIC_API_URL=" "$env_file"; then sed -i '' "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=$URL_API|g" "$env_file"; fi
    if grep -q "NEXT_PUBLIC_APP_URL=" "$env_file"; then sed -i '' "s|NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=$URL_MARKET_FIT|g" "$env_file"; fi
    if grep -q "API_BASE_URL=" "$env_file"; then sed -i '' "s|API_BASE_URL=.*|API_BASE_URL=$URL_API|g" "$env_file"; fi

    log_success "$name configured."
}

setup_repo "market-fit" "$REPO_MARKET_FIT" "$CFG_PORT_MARKET_FIT"
setup_repo "API" "$REPO_API" "$CFG_PORT_API"
setup_repo "Workflows" "$REPO_WORKFLOWS" "$CFG_PORT_WORKFLOWS"

# 7. Generate start-dev.sh
echo ""
log_info "Generating 'start-dev.sh'..."

cat > start-dev.sh <<EOF
#!/bin/bash
# Makinari Dev Starter
# Generated by install.sh

# Function to open a new tab in Terminal (macOS)
open_tab() {
    local cmd="$1"
    local title="$2"
    osascript -e "tell application \"Terminal\" to do script \"cd $INSTALL_DIR && $cmd\"" >/dev/null
}

echo "Starting Makinari Ecosystem..."

# 1. Database (if local)
if [ -d "makinari-db-scheme" ]; then
    echo "Ensuring Local DB is up..."
    cd makinari-db-scheme && supabase start
    cd ..
fi

# 2. Temporal Server (if local)
if [ "$USE_LOCAL_TEMPORAL" == "y" ]; then
    echo "Starting Temporal Server..."
    # Check if running
    if ! lsof -i :7233 >/dev/null; then
        open_tab "temporal server start-dev --ui-port 8080 --db-filename temporal.db" "Temporal Server"
    else
        echo "Temporal Server seems to be running already."
    fi
fi

# 3. Services
echo "Launching Services in new tabs..."

# Frontend
open_tab "cd market-fit && npm run dev" "Market Fit (Frontend)"

# API
open_tab "cd API && npm run dev" "API Server"

# Workers (Critical, Mail, Default)
# Assumes 'npm run start-worker -- --queue X' pattern or similar. 
# Adjust args below if package.json scripts differ.
open_tab "cd Workflows && npm run start-worker -- --queue critical" "Worker: Critical"
open_tab "cd Workflows && npm run start-worker -- --queue mail" "Worker: Mail"
open_tab "cd Workflows && npm run start-worker -- --queue default" "Worker: Default"

echo "All services launched! Check your Terminal tabs."
EOF

chmod +x start-dev.sh
log_success "start-dev.sh created."

echo ""
echo -e "${GREEN}=== INSTALLATION COMPLETE ===${NC}"
echo "You can now start everything with one command:"
echo -e "${BLUE}./start-dev.sh${NC}"
