# Installer credential requirements

The executable manifest is `scripts/credential-catalog.cjs`. Requirements describe
the supported installer configuration, not a claim that every process fails to
boot without every provider. A disabled feature has no configured provider;
the installer does not substitute mock API responses or dummy credentials.

## Inventory

| Group | Required configuration | Consumer |
| --- | --- | --- |
| Supabase | URL, public/anon key, server-only secret/service-role key | Frontend, API, workers; local keys discovered at startup |
| Internal auth | `SERVICE_API_KEY` | Frontend/API; worker `API_KEY` uses the same value |
| Encryption | `ENCRYPTION_KEY` | Frontend/API; preserve across reinstall |
| Cron | `CRON_SECRET` | API |
| Signing | Independent `VISITOR_SESSION_TOKEN_SECRET`, `VISITOR_IDENTITY_SIGNING_SECRET`, `PUBLIC_MEDIA_SIGNING_SECRET` | API |
| Redis cache | `REDIS_CACHE_URL`, `CACHE_UPSTASH_REDIS_REST_URL`, `CACHE_UPSTASH_REDIS_REST_TOKEN` | API TCP/REST; frontend uses the REST token in its authenticated `REDIS_URL` |
| Redis streams | `REDIS_STREAMS_URL` | API durable tracking/recording queues |
| Temporal Cloud | `TEMPORAL_SERVER_URL`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` | API maps to `TEMPORAL_CLOUD_API_KEY`; workers use `TEMPORAL_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` | API chat, embeddings and video; mandatory when enabled |
| Azure media/search | `MICROSOFT_AZURE_OPENAI_ENDPOINT`, `MICROSOFT_AZURE_OPENAI_API_KEY`, image/transcription/search deployment names | API; mandatory when enabled |
| Azure TTS | `AZURE_TTS_ENDPOINT`, `AZURE_TTS_API_KEY`, `AZURE_TTS_DEPLOYMENT` | API dedicated speech resource; mandatory when enabled |
| Stripe | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `API_STRIPE_WEBHOOK_SECRET` | Frontend/API separate webhook endpoints; mandatory when enabled |
| SendGrid | `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | Frontend/API transactional email; mandatory when enabled |

The two Redis endpoints must be separate. Use an evictable cache and a no-eviction
streams database with appropriate memory limits. TCP and REST cache hosts must
match. REST tokens and TCP passwords are not assumed to be interchangeable.
The wizard defaults to **local Redis**, created by Docker Compose at startup:

- Redis 7.4 cache on loopback port 6379, with `allkeys-lru` and 256 MB limit.
- Separate persistent streams Redis on port 6380, with `noeviction` and 512 MB limit.
- Authenticated [Serverless Redis HTTP](https://github.com/hiett/serverless-redis-http)
  adapter on port 8079, backed by the real cache Redis (not mocked responses).

Passwords and the REST token are independently generated and preserved privately.
The wizard permits changing ports. All published ports bind to 127.0.0.1 and must
remain private in Codespaces. Compose files and Redis configs are private under
`.installer/redis/`; volumes persist across stop/restart. The workspace path scopes
the Compose project so different workspaces do not share volumes. Host ports still
must be unique when running multiple workspaces on one machine.

Select `external` to provide existing Redis TCP/compatible REST credentials instead;
external resources are never created or stopped. Upstash is supported, and a
self-hosted TLS Redis plus compatible HTTPS REST endpoint can also be supplied.
TCP/REST host equality is enforced for Upstash; other providers may use a separate
REST gateway. A plain TCP Redis without the REST adapter is insufficient.

```bash
node scripts/local-redis.cjs start  # Creates local containers and checks PING
node scripts/local-redis.cjs stop   # Stops local containers, preserves data
```

Docker Compose v2 with `--wait` is required. Redis is version-tagged; the upstream
REST adapter currently uses its documented `latest` image, so pin its reviewed
digest for fully reproducible CI. Local behavior does not certify every Upstash
edge case (the adapter documents differences in JSON and sorted-set commands).

Local Temporal needs no cloud credentials. Cloud configuration uses API-key
authentication; certificate-based authentication is not implemented by this wizard.
Provider quotas, account permissions, deployments and webhook routing require
separate verification. Validation is offline presence/format validation only.

Stripe accepts test-mode keys only. Webhook secrets are endpoint-specific and do
not prove that a webhook destination is configured or reachable. Billing price IDs,
portal configuration, marketplace OAuth, AgentMail, browser-agent providers, Finder,
email verification, repository databases and other integrations remain feature-specific
configuration outside this initial manifest. OpenRouter does not replace Azure TTS,
images or transcription. OpenAI/Anthropic/Gemini keys alone do not configure the
current primary API routing.

## Commands

```bash
./install.sh --list-credentials  # No prompts, writes, downloads or services
./install.sh --configure         # Interactive credential configuration only
./install.sh --from-env          # Import exported variables / Codespaces secrets
./install.sh --check             # Validate the private config without printing values
./install.sh                     # Configure, clone missing repos, npm ci, write env
./start-workspace.sh             # Validate configuration and start configured services
```

`--from-env` supports `MAKINARI_DATABASE=local|cloud`,
`MAKINARI_TEMPORAL=local|cloud`, `MAKINARI_REDIS=local|external`, and comma-separated `MAKINARI_FEATURES`
(`openrouter,azure,speech,stripe,email`). Export the manifest fields as environment
variables; do not put literal credentials in command arguments or shell history.
Unlike the interactive new-local-workspace flow, unattended import requires the
internal secrets explicitly. No provider key is generated or fabricated.
New unattended configs default to local Redis and generate its credentials without
needing an Upstash account. Existing configs without a Redis mode retain external
behavior until explicitly changed; this avoids silently migrating existing data.

Private configuration lives in `.installer/credentials.json` (mode 0600, ignored).
Managed `.env` files are mode 0600. Only public Supabase and Stripe keys use
`NEXT_PUBLIC_*`; internal and provider secrets are server-only. Reconfiguration
preserves config secrets, clears disabled providers and removes stale Azure aliases
that would take precedence over the selected resource. Unrelated env entries remain.
Installer-managed overrides in `.env.local` are rejected before any service env is
written. Review those files first; do not overwrite them blindly.

Secrets containing `$`, backticks or newlines are rejected because Next.js and
plain dotenv do not round-trip them identically. Percent-encode special characters
in URL passwords. Import existing shared/encryption secrets before adopting this
installer for a workspace with encrypted data; generating new keys is not a safe
rotation or data migration.

## Current local database blocker

The checked-in historical schema includes external backend webhook destinations.
Startup now refuses that schema before starting Supabase. A reviewed, local-only
schema and a reconciled migration baseline are still required. The installer does
not edit applied migrations or disable authorization/business triggers to bypass
this blocker. Local mode discovers genuine loopback Supabase keys and cannot
retain cloud database credentials from a previous configuration.

This work does not create a disposable database, seed test identities, publish an
SDK, configure provider webhooks, or prove that the complete Codespace runs. Those
are separate bootstrap and live-verification tasks.