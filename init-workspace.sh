#!/bin/bash
# Clone missing repositories only; never pull or overwrite existing checkouts.
set -euo pipefail
cd "$(dirname "$0")"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<12)) process.exit(1)' || {
    echo 'Node.js >=22.12 is required.' >&2; exit 1;
}
setup_repo() {
    local name="$1" url="$2"
    if [ ! -d "$name" ]; then
        GIT_TERMINAL_PROMPT=0 git clone "$url" "$name"
    else
        echo "Keeping existing $name checkout unchanged."
    fi
    if [ -f "$name/package.json" ]; then
        [ -f "$name/package-lock.json" ] || { echo "$name requires a committed npm lockfile." >&2; exit 1; }
        (cd "$name" && npm ci)
    fi
}
setup_repo market-fit https://github.com/Uncodier/market-fit.git
setup_repo API https://github.com/Uncodier/API.git
setup_repo Workflows https://github.com/Uncodier/workflows.git
setup_repo makinari-db-scheme https://github.com/makinary/makinari-db-scheme.git
if [ -f .installer/credentials.json ]; then
    node scripts/workspace-config.cjs --apply
else
    echo 'Repositories ready, credentials not configured. No dummy keys were injected.'
    echo 'Run ./install.sh --list-credentials then ./install.sh --configure or --from-env.'
fi