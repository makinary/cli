#!/bin/bash
# Interactive credentials are collected before installing or starting services.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo 'Node.js >=22.12 is required.' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<12)) process.exit(1)' || {
    echo 'Node.js >=22.12 is required.' >&2; exit 1;
}
case "${1:-}" in
    qa) shift; exec node scripts/qa-installer.cjs "$@" ;;
    --start) exec bash start-workspace.sh ;;
    --existing-config)
        node scripts/workspace-config.cjs
        bash init-workspace.sh
        if [ "${2:-}" = '--start' ]; then exec bash start-workspace.sh; fi
        exit 0 ;;
    --list-credentials) exec node scripts/credential-wizard.cjs --list ;;
    --configure) exec node scripts/credential-wizard.cjs ;;
    --from-env) exec node scripts/credential-wizard.cjs --from-env ;;
    --check) exec node scripts/workspace-config.cjs ;;
    '') ;;
    *) echo 'Usage: ./install.sh [--list-credentials|--configure|--from-env|--check|--start|--existing-config [--start]|qa <prepare|create|status|destroy>]' >&2; exit 1 ;;
esac
node scripts/credential-wizard.cjs
bash init-workspace.sh
cat > start-dev.sh <<'EOF'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec bash start-workspace.sh
EOF
chmod +x start-dev.sh
echo 'Configured. Run ./start-dev.sh to start services; no services were started by the installer.'