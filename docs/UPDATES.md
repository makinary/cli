# Updates and stable public ports

The installer supports staged web updates with a built-in Node HTTP/WebSocket
proxy. No additional runtime package is required. This is a development/QA
supervisor using `npm run dev`, not a production deployment platform.

## Start once, then update while running

From the installer directory:

```bash
./install.sh --start
# In a second terminal, in the same directory:
./install.sh --update
```

Existing services started with the old `concurrently` script, or manually on the
public ports, must be stopped **once** before starting the managed supervisor.
It cannot take ownership of another process's listening port. Never kill unknown
processes to free a port. After this initial transition, web updates do not
require stopping the workspace.

The public frontend/API ports remain the configured ones (normally 3000/3001).
The supervisor launches both services on dynamically allocated loopback ports;
browser URLs, callback URLs and inter-service URLs remain on the public ports.
The proxy preserves the incoming Host header and handles WebSocket upgrades.

## What `--update` does

1. Checks that the managed supervisor is running and ready.
2. Requires clean frontend/API Git checkouts on branches with upstreams. It
   refuses uncommitted/untracked files and local commits ahead of or divergent
   from the upstream. Ignored local environment files are preserved.
3. Fetches their upstreams and exports exact candidate commits into private
   `.installer/releases/<id>/` directories. Source branches/checkouts are **not**
   changed; the release records the selected revisions.
4. Copies the existing service environment files and runs `npm ci` with the
   committed lockfiles in these isolated directories. Nothing is installed into
   the currently serving directories.
5. Starts candidate frontend/API processes on new internal ports and waits for
   both readiness checks to return HTTP **2xx**. Redirects, 4xx and 5xx do not pass.
6. Switches a single routing pointer for both services, then drains old HTTP and
   WebSocket connections for up to 30 seconds. Old process groups receive
   SIGTERM, followed by SIGKILL after up to 10 seconds.

A staging/install/readiness failure leaves the old routing in place and stops
candidate processes. Source credentials are not regenerated or printed by the
installer. As with any npm installation, dependency lifecycle scripts execute;
only update trusted repositories. Application/npm logs can contain sensitive
data and should not be published.

The active web release is recorded in `.installer/active-web.json` and reused on
restart. Keep its release directory. Staged releases are retained; there is no
automatic garbage collection. Clean up unused releases manually only after
checking the active record and that an update is not running.

## Readiness checks

The default path for both services is `/`. If the application redirects, requires
authentication or needs a stronger check, set paths **when starting**:

```bash
MAKINARI_FRONTEND_HEALTH_PATH=/health \
MAKINARI_API_HEALTH_PATH=/api/health \
./install.sh --start
```

These are examples: the service repositories must actually implement the chosen
routes. The installer does not invent health endpoints. Each candidate gets up
to two minutes; each request has a two-second timeout. HTTP readiness does not
prove database/provider availability, workflow correctness or full E2E health.
Use a suitable application-level health route for those checks.

## Scope and limits

- **Live update covers frontend and API only.** Workers, Temporal, Redis and
  Supabase are not restarted by `--update`.
- New and old web versions share infrastructure and may overlap. Changes must
  be backward-compatible with the current schema, workers, sessions, Redis data
  and API contracts. This is not a cross-service transaction: a request spanning
  the switch may encounter both versions. Warm-up requests can have side effects;
  health endpoints should be read-only.
- Existing long-lived connections stay on the old processes during draining;
  those still open after 30 seconds are interrupted and must reconnect. Browser
  assets/HMR may need a page reload. This is reduced downtime, **not a guarantee
  of zero interruption**.
- Candidate ports are selected dynamically; another process can race to claim
  one. A bind/start failure aborts the candidate rather than stopping the old one.
- One activation at a time is allowed. There is no automatic rollback after
  successful activation if an application fails later. An active-process exit
  shuts down the supervisor; inspect logs and restart after correcting the cause.
- Configuration must remain unchanged during updates. Changing credentials or
  public ports requires a controlled restart and review of staged environment
  files. A changed configuration is rejected against the active release record.

## Workers, migrations and installer updates

```bash
./install.sh --update --prepare-only
./install.sh --update --help
```

`--prepare-only` stages frontend, API and Workflows with dependencies but does not
activate anything and does not need a running supervisor. Review the resulting
release before planning a controlled worker rollout. There is no automated worker
activation: Temporal workflow compatibility/versioning and graceful task draining
must be evaluated in the actual Workflows repository first.

The installer itself and `makinari-db-scheme` are deliberately excluded from
automatic updates. Review their Git changes and update them manually with a clean
checkout and `git pull --ff-only` on the intended branch. Back up the database and
review migrations before applying them. **Never run database resets to update.**
Normal local startup still runs the existing schema safety check and
`supabase migration up --local`; live web activation does not execute migrations.

To return to manually selected source checkouts, stop the supervisor, review and
remove `.installer/active-web.json`, then start again. This requires a restart;
there is no separate live rollback command. Refresh/configure source `.env` files
before preparing further releases if credentials have changed.

The control API is a private Unix socket (`.installer/runtime.sock`, mode 0600),
not a public HTTP endpoint. A second managed start is refused. On graceful exit
Node removes the socket; after a forced kill a stale socket may remain. Remove
it only after verifying that no supervisor is running. Keep `.installer` private;
it contains credentials, copied environments and local control state.