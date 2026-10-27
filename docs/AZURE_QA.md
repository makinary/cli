# Disposable Azure QA

## Current status and installer entry point

The previously created West US 2 environment was deleted at the user's request
on 2026-10-27. `./install.sh qa destroy --id <exact-id> --yes` confirmed group
absence. No replacement VM was created. Historical evidence below is not a claim
that an environment remains running.

Use only the installer as the public lifecycle interface:

```bash
./install.sh qa prepare --source-root /absolute/repos
./install.sh qa status --id QA_ID
./install.sh qa create --id QA_ID --schema-dir /absolute/reviewed-schema --ack-reviewed-schema --approve-create
./install.sh qa destroy --id QA_ID --yes
```

Create preflight checks cost approval, exact unused ID, local-only schema config,
disabled SQL seeding, unique migration timestamps, absence of external URLs,
outbound Vault/direct HTTP dispatch and core-table foundation. Only config.toml
and SQL migrations are packaged; seeds, backups, linked metadata and function
code are excluded. This conservative check can reject legitimate local webhook
implementations; it is not proof that an accepted schema executes successfully.

Clean committed frontend/API/worker trees are archived before Azure creation;
the installer itself is packaged from the current reviewed working tree. The
remote host invokes `install.sh --existing-config` and `install.sh --start`, not
an alternate service-bootstrap implementation. Installation failures propagate;
immediate background startup failure is observed, but process survival does not
certify application/DB readiness. Post-provision errors request exact-ID cleanup.
Creation refuses an ID with existing Azure state before entering that cleanup path.

Status reports resource existence separately from QA readiness. Users and persisted
fixtures are not yet provisioned by this flow: a complete approved schema baseline
is still missing. Do not bypass that prerequisite to recreate a paid VM that cannot
run the intended commerce tests.

## Current execution evidence

The first approved attempt on 2026-10-27 created a dedicated QA resource group,
an Azure Automation managed identity/runbook and a one-time expiration schedule.
The actual managed-identity dry-run completed successfully before VM provisioning.
The VM request for Standard_D4s_v5 in East US failed with `SkuNotAvailable`
(capacity restrictions), masked by a secondary Azure CLI response-consumption error.
The provisioner requested deletion of the exact new group; a follow-up
`az group exists` returned false, and no `rg-makinari-qa-*` group remained.

No VM is running. No deployed database, test users, fixtures, provider calls or
successful E2E execution are claimed by this attempt. Private state is retained
under `.installer/qa/<id>/azure-state.json`; do not replay it or overwrite its IDs.

## Provisioning contract

West US 2 was subsequently approved as a same-cost alternative. Verified retail
rates: D4as_v5 US$0.172/hour, Standard IPv4 US$0.005/hour, E10 LRS disk
US$9.60/month prorated, excluding operations/traffic. Its VM reached
`Provisioning succeeded` / `VM running`; the scoped external expiration dry-run
passed and the one-time schedule is enabled. This proves infrastructure creation,
not application/database/QA readiness. Consult private state and live Azure for
final networking, upload and bootstrap progress.

The West US 2 attempt completed VM provisioning, restricted SSH, auto-shutdown
and host-key-verified private config transfer. Host tooling was verified live:
Node 22.23.4, Docker 29.9.2 and Docker Compose 5.6.1. Both real Redis containers
became healthy and the authenticated HTTP adapter returned PONG. Live validation
exposed unreadable mounted Redis configs after the official container dropped
privileges: files are now 0644 inside a private 0700 host directory, and startup
recreates containers when rematerializing their mounts.

This is host/Redis evidence only. Supabase schema reconstruction, identities,
fixtures, frontend/API/workers and payment/subscription journeys remain pending.
The external expiration schedule for this attempt is 2026-10-27 08:01 UTC;
auto-shutdown is 08:00 UTC. Confirm actual deletion after expiration rather than
assuming a successful dry-run guarantees future cleanup.

A second attempt was explicitly approved for Standard_D4as_v5 (same 4 vCPU/16 GB,
East US retail VM compute US$0.172/hour). Its external cleanup authorization test
completed, but VM creation also failed with `SkuNotAvailable` capacity restrictions.
The new group was deleted; the final group-existence check returned false and the
QA group list was empty. No VM, database or application bootstrap succeeded.
Both attempt states remain independently recorded in private files. Changing
region/size requires a new availability and cost review before another attempt.

`scripts/azure-qa.py` requires an existing staged configuration and explicit
`--approve-create` after cost review. It creates only a uniquely named
`rg-makinari-qa-*` group. The Automation identity receives Contributor at that
exact group scope, not subscription or production scope. The runbook checks
purpose, environment ID and exact expiration tags before accepting deletion.
Expiry runs in Azure Automation outside the VM. A dry-run proves read authorization;
it does not execute or guarantee future deletion. Monitor the actual job and
confirm group absence after expiration; Azure outages can delay cleanup.
Automation truncates schedule seconds; the scheduled time is rounded to the next
minute so the runbook cannot run before its exact deadline and reject deletion.

The four-hour deadline includes provisioning time. SSH uses a new key and caller
IPv4 /32 rule; database/application ports are not public. Auto-shutdown is a second
guard, not deletion. Export reports before expiry; deleting the group destroys
the VM/disks and can interrupt remaining QA work. Deletion of the Automation
account with its own group may terminate job reporting after the deletion is
accepted; group absence is the authoritative cleanup evidence.

## Staged credentials and remaining bootstrap work

`scripts/prepare-qa.cjs` imports only complete OpenRouter, Azure, speech and Stripe
test-mode groups from the sibling `.env.local` files. Infrastructure/internal
secrets and test identities are not copied. Redis and internal secrets are newly
generated. External email is excluded pending a disposable transport. Private
env files are staged separately, not applied to developer or production checkouts.

The historical schema cannot be concatenated into a current database safely:
it has duplicate policies, direct external webhooks, conflicting migration
timestamps and missing foundational objects, including `sale_order_items`.
An approved complete schema-only baseline or the missing historical definitions
is required. Generated local copies must retain provenance, resolve dependencies
and route webhooks only to local services without editing applied source files.

Once infrastructure and schema are verified: install pinned application revisions,
discover genuine local Supabase keys, create isolated Auth users, verify profiles
and memberships, provision named fixtures, and run smoke/buyer/roles/regression.
Paid checkout and subscription testing additionally need Stripe test-mode webhook
forwarding and fixtures; existing browser regression does not cover every payment
or subscription lifecycle automatically. Never describe a staged config as a
running QA environment or a browser listing as a passed suite.