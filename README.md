# Makinari Installer (CLI)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/makinary/cli)

A "One-Liner" installer to deploy the complete **Makinari** ecosystem locally or in a Dev Container.

This repository is the entry point for developers and AI agents. It automates the setup of:

*   **Market Fit** (Frontend - Next.js)
*   **API** (Backend - Next.js API Routes)
*   **Workflows** (Process Engine - Temporal + Node.js)
*   **Local Database** (Supabase + Docker)
*   **Local Temporal Server**
*   **Local Redis cache, durable streams and authenticated REST adapter**, or external Redis
*   **Credential inventory and validation**

See [credential requirements](docs/CREDENTIALS.md) for the authoritative installer
inventory, enabled-feature requirements, Redis TCP/REST compatibility and current
local-schema safety blocker. Run `./install.sh --list-credentials` to list requirements
without installing or starting anything.

## Single-entry-point QA lifecycle

All QA operations now enter through `install.sh`; helper scripts are internal.

```bash
./install.sh qa prepare --source-root /absolute/path/to/service-repositories
./install.sh qa status --id QA_ID
./install.sh qa create --id QA_ID --schema-dir /absolute/path/to/reviewed-schema --ack-reviewed-schema --approve-create
./install.sh qa destroy --id QA_ID --yes
```

`prepare` prints a unique `qa-...` ID and imports permitted provider credentials
without copying production infrastructure credentials. `create` requires a
reviewed complete local-only schema **before** creating paid Azure resources.
It packages clean service revisions and invokes this same installer remotely,
with local Supabase/Redis/Temporal and four-hour Azure expiry. A missing/incomplete
schema, dirty service checkout or existing attempt ID stops creation. No `latest`
environment is inferred and a failed retry cannot adopt/delete an existing VM.

The original manually bootstrapped QA environment was explicitly deleted on
2026-10-27; deletion was confirmed through the installer. No replacement was
created by this integration. Schema reconstruction, QA users/fixtures and complete
payment/subscription E2E remain pending; see [Azure QA](docs/AZURE_QA.md).

---

## ☁️ One-Click Environment (Codespaces & Dev Containers)

The easiest way to start working on Makinari is using the pre-configured Dev Container. It contains all dependencies (Docker-in-Docker, Node.js, Supabase CLI, Temporal CLI).

### For Human Developers
1. Click the **"Open in GitHub Codespaces"** badge above.
2. The environment will build and automatically run `init-workspace.sh` to clone all repositories and set up `.env` files.
3. Configure credentials with `./install.sh --configure` (or `--from-env`
   using Codespaces secrets). Once the configuration is ready, run:
   ```bash
   ./start-workspace.sh
   ```
4. Startup validates configuration and refuses unsafe
   external webhook destinations in the historical local schema.

### For AI Agents
Agents can clone this repository into any Dev Container or Linux environment with Docker, and run:
```bash
./init-workspace.sh
./start-workspace.sh
```
Initialization is non-interactive, keeps existing checkouts unchanged and uses
`npm ci`. It no longer injects dummy keys. Configure credentials before startup.

---

## 💻 Local Setup (macOS Interactive Wizard)

If you prefer to run the ecosystem on your local machine (macOS recommended), you can use the legacy interactive wizard. 

### Prerequisites (Local)
*   Git
*   Node.js (v22.12+)
*   Docker Desktop (required for local DB)
* Supabase CLI and Temporal CLI for local modes; `tsx` 4.23.15 for workers.
* Docker Compose v2 for local Redis; external Redis credentials are optional.
The devcontainer installs the CLI tools. Local users must install them explicitly.

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
    *   Create local Redis (default), or provide external cache TCP/REST and streams credentials.
    *   Internal authentication, encryption and independent signing secrets.
    *   Enable OpenRouter, Azure, TTS, Stripe or SendGrid; each enabled feature
        requires its complete credential group. Stripe uses test credentials only.

### How to Start (Local)

Once installation is complete, a `start-dev.sh` wrapper is generated. To start
the configured services with a managed supervisor and stable web ports, run:

```bash
./start-dev.sh
```

### Updates without stopping the web services first

```bash
./install.sh --update
```

With the managed workspace running, this stages clean upstream frontend/API
revisions in isolated directories, installs locked dependencies, starts them on
new internal ports, verifies HTTP readiness and switches the stable public ports.
Failed candidates leave the previous release serving. Old connections drain for
up to 30 seconds before the old processes stop.

Services started with the previous startup script require **one initial restart**
to adopt the proxy. Live updates do not update workers, infrastructure, database
migrations or the installer itself. Use `./install.sh --update --prepare-only`
to stage frontend/API/Workflows without activation. See [update procedures and
limitations](docs/UPDATES.md), including health paths, compatibility and recovery.

---

## 📦 Resulting Structure

Upon completion of either method, you will have a folder structure like this:

```
cli/
├── install.sh             # macOS interactive script
├── init-workspace.sh      # Automated non-interactive script
├── start-workspace.sh     # Cross-platform managed startup script
├── market-fit/            # Frontend Repo
├── API/                   # Backend Repo
├── Workflows/             # Process Engine Repo
└── makinari-db-scheme/    # DB Schema & Migrations
```

## 🤝 Contributing

If you need to improve the installation process or add new services to the ecosystem, edit the relevant scripts and submit a Pull Request to this repository.
