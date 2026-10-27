FROM mcr.microsoft.com/devcontainers/javascript-node:22

# Install dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends curl ca-certificates jq

# Install Supabase CLI
RUN curl -Lo supabase.deb "https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.deb" \
    && dpkg -i supabase.deb \
    && rm supabase.deb

# Install Temporal CLI
RUN curl -sSf https://temporal.download/cli.sh | sh \
    && cp /root/.temporalio/bin/temporal /usr/local/bin/temporal \
    && chmod +x /usr/local/bin/temporal

# Pre-install concurrently to run multiple services in start-workspace.sh
RUN npm install -g concurrently
