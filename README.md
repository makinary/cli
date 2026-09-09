# Makinari Installer (CLI)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/makinary/cli)

A "One-Liner" installer to deploy the complete **Makinari** ecosystem locally or in a Dev Container.

This repository is the entry point for developers and AI agents. It automates the setup of:

*   **Market Fit** (Frontend - Next.js)
*   **API** (Backend - Next.js API Routes)
*   **Workflows** (Process Engine - Temporal + Node.js)
*   **Local Database** (Supabase + Docker)
*   **Local Temporal Server**

---

## ☁️ One-Click Environment (Codespaces & Dev Containers)

The easiest way to start working on Makinari is using the pre-configured Dev Container. It contains all dependencies (Docker-in-Docker, Node.js, Supabase CLI, Temporal CLI).

### For Human Developers
1. Click the **"Open in GitHub Codespaces"** badge above.
2. The environment will build and automatically run `init-workspace.sh` to clone all repositories and set up `.env` files.
3. Once the terminal is ready, run:
   ```bash
   ./start-workspace.sh
   ```
4. All services (Frontend, API, Workflows, Database, and Temporal) will start concurrently.

### For AI Agents
Agents can clone this repository into any Dev Container or Linux environment with Docker, and run:
```bash
./init-workspace.sh
./start-workspace.sh
```
This is fully non-interactive and handles cloning, dependency installation, dummy `.env` injection, and concurrent service execution.

---

## 💻 Local Setup (macOS Interactive Wizard)

If you prefer to run the ecosystem on your local machine (macOS recommended), you can use the legacy interactive wizard. 

### Prerequisites (Local)
*   Git
*   Node.js (v18+)
*   Docker Desktop (required for local DB)
*(The installer will attempt to install missing CLI tools via Homebrew).*

### Quick Install (Local)

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

### How to Start (Local)

Once the interactive installation is complete, a `start-dev.sh` file is generated. To start all services in separate macOS Terminal tabs, run:

```bash
./start-dev.sh
```

---

## 📦 Resulting Structure

Upon completion of either method, you will have a folder structure like this:

```
cli/
├── install.sh             # macOS interactive script
├── init-workspace.sh      # Automated non-interactive script
├── start-workspace.sh     # Cross-platform concurrent startup script
├── market-fit/            # Frontend Repo
├── API/                   # Backend Repo
├── Workflows/             # Process Engine Repo
└── makinari-db-scheme/    # DB Schema & Migrations
```

## 🤝 Contributing

If you need to improve the installation process or add new services to the ecosystem, edit the relevant scripts and submit a Pull Request to this repository.
