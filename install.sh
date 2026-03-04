#!/bin/bash

# Makinari Interactive Installer (Wizard) v3
# Installs and configures Market Fit, API, and Workflows services with Cross-Dependency Resolution
# & Automatic Docker/Supabase Setup

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

check_and_install_docker() {
    log_info "Checking Docker installation..."
    
    if command_exists docker; then
        log_success "Docker is installed."
    else
        log_warn "Docker is not installed."
        
        # Check OS
        if [[ "$OSTYPE" == "darwin"* ]]; then
            log_info "Detected macOS."
            if command_exists brew; then
                prompt_input "Install Docker via Homebrew? (y/n)" "y" INSTALL_DOCKER
                if [ "$INSTALL_DOCKER" == "y" ]; then
                    log_info "Installing Docker Desktop..."
                    brew install --cask docker
                    log_success "Docker installed. Opening Docker Desktop..."
                    open -a Docker
                else
                    log_error "Docker is required for local database. Please install it manually."
                    exit 1
                fi
            else
                log_error "Homebrew not found. Please install Docker Desktop manually: https://www.docker.com/products/docker-desktop/"
                exit 1
            fi
        else
            log_error "Automatic Docker installation is only supported on macOS. Please install Docker manually."
            exit 1
        fi
    fi

    # Check if Docker Daemon is running
    log_info "Checking if Docker Daemon is running..."
    if ! docker info > /dev/null 2>&1; then
        log_warn "Docker is not running. Attempting to start..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
             open -a Docker
        fi
        
        log_info "Waiting for Docker to start (this may take a minute)...";
        while ! docker info > /dev/null 2>&1; do
            echo -n "."
            sleep 2
        done
        echo ""
        log_success "Docker is running!"
    else
        log_success "Docker is already running."
    fi
}

check_and_install_supabase() {
    log_info "Checking Supabase CLI..."
    if command_exists supabase; then
        log_success "Supabase CLI is installed."
    else
        log_warn "Supabase CLI is not installed."
        if [[ "$OSTYPE" == "darwin"* ]] && command_exists brew; then
             log_info "Installing Supabase CLI via Homebrew..."
             brew install supabase/tap/supabase
             log_success "Supabase CLI installed."
        else
             log_error "Please install Supabase CLI manually: https://supabase.com/docs/guides/cli"
             exit 1
        fi
    fi
}

# --- Main Script ---

clear
echo -e "${BLUE}=======================================${NC}"
echo -e "${BLUE}   Makinari - Interactive Installer    ${NC}"
echo -e "${BLUE}=======================================${NC}"
echo "This wizard will help you set up the Makinari ecosystem with interconnected services."
echo "Directory: $INSTALL_DIR"
echo ""

# 1. Check Prerequisites
log_info "Checking prerequisites..."
if ! command_exists git; then log_error "git is required but not installed."; exit 1; fi
if ! command_exists npm; then log_error "npm is required but not installed."; exit 1; fi
log_success "Basic tools met."
echo ""

# 2. Service Configuration (Wizard)
log_info "Let's configure the services and their ports."
prompt_input "Market Fit (Frontend) Port" "$PORT_MARKET_FIT" CFG_PORT_MARKET_FIT
prompt_input "API Server Port" "$PORT_API" CFG_PORT_API
prompt_input "Workflows Service Port" "$PORT_WORKFLOWS" CFG_PORT_WORKFLOWS

# Derive Base URLs
URL_MARKET_FIT="http://localhost:$CFG_PORT_MARKET_FIT"
URL_API="http://localhost:$CFG_PORT_API"
URL_WORKFLOWS="http://localhost:$CFG_PORT_WORKFLOWS"

log_info "Service URLs configured:"
echo " - Frontend:  $URL_MARKET_FIT"
echo " - API:       $URL_API"
echo " - Workflows: $URL_WORKFLOWS"
echo ""

# 3. Database & AI Configuration
log_info "Database Configuration"
prompt_input "Use local Supabase? (y/n)" "n" USE_LOCAL_SUPABASE

CFG_SUPABASE_URL=""
CFG_SUPABASE_KEY=""

if [ "$USE_LOCAL_SUPABASE" == "y" ]; then
    # Ensure Docker and Supabase CLI are ready
    check_and_install_docker
    check_and_install_supabase
    
    log_info "Setting up Local Database..."
    
    # Clone DB Scheme Repo
    if [ ! -d "makinari-db-scheme" ]; then
         log_info "Cloning Database Scheme..."
         git clone "$REPO_DB_SCHEME" makinari-db-scheme
    else
         log_warn "makinari-db-scheme directory already exists. Updating..."
         cd makinari-db-scheme && git pull && cd ..
    fi
    
    log_info "Starting Supabase Local..."
    cd makinari-db-scheme
    supabase start
    
    # Extract Credentials
    log_info "Extracting Local Credentials..."
    STATUS_OUTPUT=$(supabase status)
    
    # Grep for URL and Key (Assuming standard output format)
    CFG_SUPABASE_URL=$(echo "$STATUS_OUTPUT" | grep "API URL" | awk '{print $4}')
    CFG_SUPABASE_KEY=$(echo "$STATUS_OUTPUT" | grep "service_role key" | awk '{print $4}')
    
    if [ -z "$CFG_SUPABASE_URL" ] || [ -z "$CFG_SUPABASE_KEY" ]; then
        log_error "Failed to extract Supabase credentials. Please check 'supabase status' output."
        exit 1
    fi
    
    log_success "Local Database Ready!"
    log_info "URL: $CFG_SUPABASE_URL"
    cd ..
else
    # Remote Database
    prompt_input "Supabase URL" "" CFG_SUPABASE_URL
    prompt_secret "Supabase Service Role Key" CFG_SUPABASE_KEY
fi

echo ""
log_info "AI Configuration (Leave empty to skip if not needed immediately)"
prompt_secret "OpenAI API Key" CFG_OPENAI_KEY
prompt_secret "Anthropic API Key" CFG_ANTHROPIC_KEY
prompt_secret "Gemini API Key" CFG_GEMINI_KEY
echo ""

# 4. Setup Repositories & Environments
setup_repo() {
    local name=$1
    local url=$2
    local port=$3
    local dir="$INSTALL_DIR/$name"

    echo -e "\n${BLUE}--- Setting up $name ---${NC}"

    if [ -d "$dir" ]; then
        log_warn "Directory $name already exists. Updating..."
        cd "$dir" || exit
        git pull || log_warn "Git pull failed, skipping update for $name"
    else
        log_info "Cloning $name..."
        git clone "$url" "$dir"
        cd "$dir" || exit
    fi

    # Install dependencies
    if [ -f "package.json" ]; then
        log_info "Installing dependencies..."
        npm install --silent
    fi

    # Configure Environment
    log_info "Configuring environment..."
    
    # Determine template file
    local env_template=""
    if [ -f ".env.example" ]; then env_template=".env.example"; 
    elif [ -f "env.example" ]; then env_template="env.example";
    fi

    if [ -n "$env_template" ]; then
        cp "$env_template" .env
        
        # --- Common Replacements ---
        if [ -n "$CFG_SUPABASE_URL" ]; then
            sed -i '' "s|NEXT_PUBLIC_SUPABASE_URL=.*|NEXT_PUBLIC_SUPABASE_URL=$CFG_SUPABASE_URL|g" .env
            sed -i '' "s|SUPABASE_URL=.*|SUPABASE_URL=$CFG_SUPABASE_URL|g" .env
        fi
        
        if [ -n "$CFG_SUPABASE_KEY" ]; then
            sed -i '' "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$CFG_SUPABASE_KEY|g" .env
            sed -i '' "s|SUPABASE_KEY=.*|SUPABASE_KEY=$CFG_SUPABASE_KEY|g" .env
        fi
        
        if [ -n "$CFG_OPENAI_KEY" ]; then
            sed -i '' "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=$CFG_OPENAI_KEY|g" .env
        fi
        
        if [ -n "$CFG_ANTHROPIC_KEY" ]; then
             sed -i '' "s|ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$CFG_ANTHROPIC_KEY|g" .env
        fi
        
        if [ -n "$CFG_GEMINI_KEY" ]; then
             sed -i '' "s|GEMINI_API_KEY=.*|GEMINI_API_KEY=$CFG_GEMINI_KEY|g" .env
        fi

        # --- Cross-Service Dependency Injection ---
        
        # 1. Inject API URL into Frontend & Workflows
        # Look for NEXT_PUBLIC_API_URL, API_BASE_URL, NEXT_PUBLIC_ORIGIN
        if grep -q "NEXT_PUBLIC_API_URL=" .env; then
             sed -i '' "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=$URL_API|g" .env
        else
             echo "NEXT_PUBLIC_API_URL=$URL_API" >> .env
        fi

        if grep -q "API_BASE_URL=" .env; then
             sed -i '' "s|API_BASE_URL=.*|API_BASE_URL=$URL_API|g" .env
        fi

        # 2. Inject Frontend URL into API (for CORS/Redirects)
        if grep -q "NEXT_PUBLIC_APP_URL=" .env; then
             sed -i '' "s|NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=$URL_MARKET_FIT|g" .env
        fi
        
        # 3. Inject Port Configuration (if supported by framework via PORT env var)
        if ! grep -q "PORT=" .env; then
            echo "PORT=$port" >> .env
        else
            sed -i '' "s|PORT=.*|PORT=$port|g" .env
        fi

        log_success "Environment configured for $name"
    else
        log_warn "No .env template found for $name. Skipping auto-config."
    fi
}

setup_repo "market-fit" "$REPO_MARKET_FIT" "$CFG_PORT_MARKET_FIT"
setup_repo "API" "$REPO_API" "$CFG_PORT_API"
setup_repo "Workflows" "$REPO_WORKFLOWS" "$CFG_PORT_WORKFLOWS"

echo ""
echo -e "${BLUE}=======================================${NC}"
echo -e "${GREEN}   Installation Complete!             ${NC}"
echo -e "${BLUE}=======================================${NC}"
echo "Services have been set up in $INSTALL_DIR"
if [ "$USE_LOCAL_SUPABASE" == "y" ]; then
    echo "Local Supabase is running at $CFG_SUPABASE_URL"
    echo "Dashboard: http://localhost:54323"
fi
echo ""
echo "To start the services (in separate terminals):"
echo "1. Market Fit (Frontend):  cd market-fit && npm run dev"
echo "2. API Server:             cd API && npm run dev"
echo "3. Workflows:              cd Workflows && npm run dev"