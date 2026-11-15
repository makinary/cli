#!/bin/bash
# Host tools only. Does not start application services, providers or database migrations.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo 'Run host bootstrap with sudo.' >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git jq unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# Install Node via official distribution tarball; resolve the current maintained 22.x release.
NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version')
case "$NODE_VERSION" in v22.*) ;; *) echo 'Node version discovery failed.' >&2; exit 1;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
archive="node-${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${archive}"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
grep " ${archive}\$" SHASUMS256.txt | sha256sum --check -
tar -xJf "$archive" --strip-components=1 -C /usr/local
node --version
npm install -g concurrently tsx@4.23.15
# Keep the QA config normalizer and CLI on one reviewed version. Never resolve latest.
SUPABASE_VERSION=3.1.0
SUPABASE_DEB_URL=$(curl -fsSL "https://api.github.com/repos/supabase/cli/releases/tags/v${SUPABASE_VERSION}" | \
    jq -er --arg name "supabase_${SUPABASE_VERSION}_linux_amd64.deb" '.assets[] | select(.name == $name) | .browser_download_url')
if [ "$SUPABASE_DEB_URL" != "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_amd64.deb" ]; then
    echo 'Invalid pinned Supabase release asset.' >&2; exit 1
fi
curl -fsSL "$SUPABASE_DEB_URL" -o supabase.deb
dpkg -i supabase.deb
if [ "$(supabase --version)" != "$SUPABASE_VERSION" ]; then
    echo 'Installed Supabase version does not match the QA pin.' >&2; exit 1
fi
curl -fsSL https://temporal.download/cli.sh -o temporal-install.sh
bash temporal-install.sh
install -m 0755 /root/.temporalio/bin/temporal /usr/local/bin/temporal
command -v concurrently
supabase --version
temporal --version
docker version --format '{{.Server.Version}}'
docker compose version
echo 'QA host tools ready. Application/schema/bootstrap remain separate.'