# Makinari Installer (CLI)

A "One-Liner" installer to deploy the complete **Makinari** ecosystem locally.

This repository is the entry point for developers. It automates the setup of:

*   **Market Fit** (Frontend - Next.js)
*   **API** (Backend - Next.js API Routes)
*   **Workflows** (Process Engine - Temporal + Node.js)
*   **Local Database** (Supabase + Docker) - *Optional & Automatic!*
*   **Local Temporal Server** - *Optional & Automatic!*

The installer automatically handles:
*   Dependency installation (Docker, Supabase CLI, Temporal CLI, Node.js packages).
*   Service startup (Docker Desktop, Temporal Server).
*   Repository cloning.
*   Cross-environment variable configuration `.env` (API URLs, CORS, Ports).
*   Credential injection for local Supabase and Temporal into all services.
*   **Generation of a `start-dev.sh` script** to launch the entire stack with one command.

## 🚀 Quick Install

1.  Clone this repository:
    ```bash
    git clone https://github.com/makinary/cli.git
    cd cli
    ```

2.  Run the interactive wizard:
    ```bash
    ./install.sh
    ```

3.  Follow the on-screen instructions. The wizard will ask:
    *   Whether to use **Local Supabase** (recommended for dev) or connect to a cloud instance.
    *   Whether to run a **Local Temporal Server**.
    *   Preferred ports for each service (or use defaults).
    *   Optional API keys (OpenAI, Anthropic, Gemini).

## 📦 Resulting Structure

Upon completion, you will have a folder structure like this:

```
cli/
├── install.sh          # The master script
├── start-dev.sh        # The generated startup script
├── market-fit/         # Frontend Repo
├── API/                # Backend Repo
├── Workflows/          # Process Engine Repo
└── makinari-db-scheme/ # DB Schema & Migrations (only if using local DB)
```

## 🛠 Prerequisites

The installer will attempt to automatically install missing tools (on macOS via Homebrew), but ideally you should have:
*   Git
*   Node.js (v18+)
*   Docker Desktop (required for local DB)

## 🏃‍♂️ How to Start

Once installation is complete, a `start-dev.sh` file will be generated in the root directory.

To start the entire ecosystem (Frontend, API, Workflows, Workers, DB, Temporal) in separate terminal tabs, simply run:

```bash
./start-dev.sh
```

Alternatively, you can start services individually:

1.  **Frontend:** `cd market-fit && npm run dev`
    *(Default: http://localhost:3000)*

2.  **API:** `cd API && npm run dev`
    *(Default: http://localhost:3001)*

3.  **Workflows:** `cd Workflows && npm run dev`
    *(Default: http://localhost:3002)*

4.  **Database (if local):**
    The installer leaves it running. Dashboard at `http://localhost:54323`.
    Stop: `cd makinari-db-scheme && supabase stop`
    Start: `cd makinari-db-scheme && supabase start`

## 🤝 Contributing

If you need to improve the installation process or add new services to the ecosystem, edit `install.sh` and submit a Pull Request to this repository.
