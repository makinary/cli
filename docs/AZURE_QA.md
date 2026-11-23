# Disposable Azure QA

## Bounded Automation runbook publication

The Azure CLI can wait for a response body after Azure has already accepted a
runbook draft upload. To avoid blocking before expiry is configured, the installer
now uses Azure's `text/powershell` media type and handles the upload and publish
responses by status without consuming the body. It uses bounded readbacks at the
fixed ARM endpoints to verify the exact draft and published content, not a
response-provided URL. The runbook must be `Published` before its schedule is
linked and dry-run. Unconfirmed expiry still blocks VM creation and triggers
exact-group cleanup.

## Local Temporal worker admission — 2026-11-16

The fresh repaired QA replay reached healthy Supabase, but workers raced the
local Temporal server's transport startup and exited with connection refused.
The supervisor now binds Temporal explicitly to loopback port 7233 and waits up
to 60 seconds for that socket before launching workers. It fails on local child
exit, runtime shutdown or timeout; worker SDK connections still perform the real
Temporal handshake. It does not retry business operations or adopt external
Temporal settings. New delayed-listener/exit/shutdown/timeout checks plus existing
runtime tests passed 61 cases. The two-file change was uploaded as a reviewed
overlay to exact QA `qa-1794712685585-f5501631`; frontend/API then returned 200.
This overlay is not yet published and is not a clean-installer release certificate.

## Supabase CLI compatibility repair — 2026-11-14

The disposable attempt `qa-1794707562780-19f73f1e` created its Azure VM but
failed before backend readiness: Supabase CLI 3.1.0 rejects the legacy
`[inbucket]` configuration. The exact group was deleted and absence verified.

The installer now normalizes `[inbucket]` to `[local_smtp]` only in the temporary
schema copy during packaging, before creating paid resources. An already-modern
section is preserved. Exactly one mail section must be present, enabled and bound
to port 54324; missing, ambiguous, disabled or wrong-port configurations fail
without modifying the input or writing Auth templates. Additional transport
settings and comments are retained. Auth confirmation/recovery templates, exact
loopback redirects and disabled seed guards remain enforced. The original schema
checkout and applied migrations are not edited.

The Azure host bootstrap pins Supabase CLI **3.1.0**, resolves the exact Debian
asset from that release tag and verifies the installed version. It no longer
downloads `latest`. The existing `TEST_INBUCKET_URL` remains the mailbox endpoint
name for browser helpers; its loopback URL/port do not change. This repair does
not authorize external email, production access or replacement infrastructure.

Validation: the complete installer Jest battery passed **11 suites / 200 tests**,
including new executable Python/TOML regressions for legacy and modern mail,
ambiguous sections, disabled mail, wrong ports and unchanged original files.
Shell syntax and diff checks passed. The official Darwin ARM64 CLI 3.1.0 binary
was downloaded privately and its SHA256 verified against the release checksums.
Running `supabase status` against isolated copies of the actual bootstrap config
reproduced the legacy `[inbucket]` rejection; the normalized copy passed config
loading and reached the unavailable local Docker check. Original config bytes
were unchanged. This is not a successful fresh backend replay or live E2E
certificate. Reattempt via `install.sh qa prepare/create` with a new
exact ID, reviewed schema and explicit cost approval; never reuse the deleted ID.

## Initial battery and suite execution

### Local managed-runtime control

Use `./install.sh --stop` to stop the current local supervisor before a reviewed
restart; do not locate it by matching an assumed process command string. This
uses `scripts/runtime-control.cjs stop --root <canonical-installer-root>` over
the user-owned mode-0600 Unix socket. The helper checks exact root, socket type,
ownership and server-instance identity, then waits for graceful child/public-port
shutdown. It never selects arbitrary PIDs, removes live sockets or trusts HTTP
Host/forwarded headers. Other roots, symlink aliases, replaced sockets and
unconfirmed shutdown fail closed. This command stops services, not Docker data
or Azure resources; exact QA destruction remains a separate installer operation.

`node scripts/runtime-control.cjs status --root /canonical/absolute/root` returns
local supervisor state. Do not expose the control socket over a public port.

The installer now exposes `qa provision`, `qa run --suite` and `qa results`, all
requiring exact IDs. Provision/run require `--yes`; actual Azure ownership/expiry
are checked before local-only mutations. Suites are sequential. A full regression
requires at least 7,500 seconds before expiry; account lifecycle requires 1,500
seconds (frontend timeout: 1,200 seconds); procurement and subsystems each require
1,800 seconds (20-minute module policy plus overhead); project lifecycle and other
shorter runs require 900 seconds.
Provision requires 1,500 seconds for upload, browser installation and fixture
creation. After uploading the reviewed tests, it runs the existing installed CLI
`npx --no-install playwright install --with-deps chromium` in the QA application
directory, with a 600-second timeout and private `qa-browser-install.log` on the
VM. This installs the matching Chromium revision and OS dependencies, not another
Playwright package/version; lockfiles are unchanged and no application build runs.
Installation failure stops provision before fixtures. Suite execution never
installs browsers automatically, skips tests or converts a missing browser into
success; provision must complete before an explicitly selected run.
No automatic extension is performed. Results saves safe machine summaries and
per-test diagnostic evidence locally without exporting raw traces/auth state/provider
payloads. An incomplete export returns nonzero and explains the extraction gap.

`procurement` and `subsystems` are explicit isolated mutating suites, not part of
smoke or regression discovery. Both use native `@playwright/test` assertions and
do not require AI-provider configuration. The runner enables both mutation flags
only for the selected mutating suite and does not grant either lifecycle capability
to module suites. Verified QA fixtures, exact run/QA identity, local loopback
origins, a public Supabase key and expiry remain mandatory. Run sequentially:

```sh
./install.sh qa run --id QA_ID --suite procurement --yes
./install.sh qa results --id QA_ID --suite procurement
./install.sh qa run --id QA_ID --suite subsystems --yes
./install.sh qa results --id QA_ID --suite subsystems
```

Wait for each run to finish before starting the next. Procurement's immutable
run-owned records are retained until exact QA destruction; no global cleanup is
authorized. Evidence permits only reviewed procurement/subsystems project enums
and exact spec/support paths, never arbitrary paths in those directories. These
commands do not authorize creation, packaging-rule changes or expiry extensions;
offline validation is not live suite success.

### Preserve exact-run diagnostic evidence before destruction

After each suite finishes, run `./install.sh qa results --id QA_ID` **before**
`qa destroy` or automatic expiry. It exports only runs named
`QA_ID-SUITE-<8 lowercase hex characters>` and checks each manifest/summary's exact
run ID, suite and local target. Retries remain separate runs; health indexes,
neighboring environments and raw engine logs are never merged or used as evidence.
`--suite SUITE` optionally limits the export; there is no inferred latest run.

Private local outputs under `.installer/qa/QA_ID/` (mode `0600`, atomic replacement):

- `test-summaries.json`: existing run summaries, now also retaining original
  `expectedCount`, `selectedCount`, `missing`, `unexpected` and scope. Missing
  metadata remains `null`, never an inferred zero.
- `test-evidence.json`: one record per exact run, including selected/setup/unexpected
  cases, outcome, attempt status/retry/duration, nested step indexes, safe locations
  and explicit extraction status/error codes. Titles, including test/suite/step and
  function names, are **omitted entirely**. A case is identified by selection index,
  project enum and local source location, not a possibly password-bearing title.
- `test-evidence-error.json`: safe enum-only transport/validation failure, with no
  invented results; the previous successful exports are retained on these failures.
  A later successful extraction removes this error file.

The dependency-free Node helper reads `run-manifest.json`, `run-summary.json` and
the exact run's `playwright.json` **on the VM**. It reads `test.results`, both
`error` and `errors`, and nested steps; original raw JSON never leaves the VM.
Stack frames become repository-relative file/line/column records only when the
file belongs to the fixed reviewed harness-path allowlist and exists in the source
catalog (including generated filenames derived from allowed YAML files). Merely
matching a filename pattern is insufficient: token-bearing source filenames are
excluded, even if they exist. New harness paths require explicit allowlist review.
URL/function/stack text and unknown
paths are discarded. Generated YAML test locations remain identifiable by their
source-derived filenames. When the source line exists, hints include only fixed
assertion-method, operation and locator-property enums (never locator values).
Endpoint hints allow only fixed reviewed paths or masked public-document/shop/book
prefixes; origins, dynamic tails, query strings and fragments are never exported.
Unknown error text remains `UNKNOWN_ERROR`, not a copied message fragment or an
invented provider/auth diagnosis. Headers, bodies, attachments, stdout/stderr,
auth state, account journals, passwords, email addresses and provider responses
are excluded. The local helper validates this strict schema again before saving.

Review each run's extraction status, `detailCount`, `selectedMissingCount` and
original counts. `REPORT_MISSING`/`REPORT_INVALID`, ID mismatch, missing selected
results, duplicate cases, count mismatch and unavailable source locations are
explicit gaps. Missing cases have `outcome=unavailable`, no attempts and no
fabricated failure details. In-progress/blocked runs can preserve summary counts
without any per-test evidence. Export is not a suite rerun, cloud publication,
cleanup confirmation or a guarantee that incomplete evidence can be recovered.

**Historical limit:** `qa-1793220482163-d601ed05` was deleted after saving only
summary counts (regression: 1 passed, 47 failed, 2 blocked) and smoke traces.
Individual regression errors/steps were not retained; their details cannot be
recovered from aggregate counts or smoke evidence. This exporter cannot reconstruct
that deleted run. A newly approved disposable rerun is required to obtain them;
no new VM, provider calls or live browser run are authorized by this change.

### Isolated lifecycle acceptance commands

After approved creation and verified fixture provisioning, select the exact ID;
these commands are documentation, not authorization to create or run an environment:

```bash
./install.sh qa provision --id QA_ID --yes
./install.sh qa run --id QA_ID --suite account-lifecycle --yes
./install.sh qa results --id QA_ID
./install.sh qa run --id QA_ID --suite project-lifecycle --yes
./install.sh qa results --id QA_ID
./install.sh qa destroy --id QA_ID --yes
./install.sh qa status --id QA_ID
```

Wait for each suite to finish before starting the next. Installer execution uses
`--target local` on the disposable VM, never a remote application URL. Both suites
receive `TEST_ALLOW_MUTATIONS=1` and `TEST_DISPOSABLE_ENVIRONMENT=1`; only the
requested suite receives its matching `TEST_ALLOW_ACCOUNT_LIFECYCLE=1` or
`TEST_ALLOW_PROJECT_LIFECYCLE=1`. Non-requested lifecycle flags are explicitly `0`.
Account lifecycle alone receives `TEST_INBUCKET_URL=http://127.0.0.1:54324`.
The verified fixture battery supplies `QA_STATUS=VERIFIED` and the matching
`QA_ENVIRONMENT_ID`; `QA_EXPIRES_AT` comes from the ownership-checked Azure state.
Smoke/buyer receive no mutation permission; roles/regression retain disposable
mutation permission but no lifecycle permission or Inbucket URL.

**Fresh-package email configuration:** `qa-lifecycle.py` invokes
`scripts/qa-auth-config.py` only after copying the reviewed immutable config into
its temporary staging directory. Packaging requires Python 3.11+ (`tomllib`). The
helper requires project `makinari-qa`, exact
`http://127.0.0.1:3000` Auth site URL, disabled seeds, and local enabled Inbucket on
port 54324. It enables email confirmations and permits only exact loopback
`/auth/callback`, `/auth/confirm` and `/auth/reset-password` redirects. Existing
confirmation/recovery template configuration or files are rejected, not overwritten.
The packaged `supabase/templates/qa-confirmation.html` and `qa-recovery.html` link to
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&returnTo=%2Fprojects`
and the same URL with `type=recovery`. This uses the application's manual confirmation
flow rather than stock hash-session links. The original schema config/manifest and
applied migrations are unchanged. No override is applied to existing VMs or production
Auth settings by the installer. The generated static files explicitly use mode
`0644` inside the private QA project so the Kong container can read them even when
packaging uses `umask 077`. They do not contain rendered tokens or credentials.
Unreadable files return 403 and Auth falls back to stock confirmation links.
An already initialized environment with confirmations disabled still
cannot pass account signup acceptance; only a newly approved, freshly packaged QA
initialization receives these settings. Template delivery and runtime acceptance
remain unverified live; local tests do not claim a browser lifecycle pass.

New account cleanup is destruction of the **exact** disposable environment, with
group absence verified afterward; project archival alone does not remove Auth
users. Keep the account journal private, recording created user IDs but never
passwords, confirmation/reset links or tokens. Do not export raw browser traces,
mailbox payloads or auth state as safe summaries. No live lifecycle pass is claimed
by installer support or local source-contract tests.
`qa results` exports safe run summaries and diagnostics, not the account journal. Before
destruction, an explicitly approved manual private export may retain
`~/qa/market-fit/.auth/local/RUN_ID/account-lifecycle-journal.json` for cleanup
evidence (user IDs and `cleanup.completed=false` while accounts still exist).
Do not export neighboring auth-state files or mailbox payloads. Record exact group
deletion and subsequent status/absence verification separately; do not relabel a
pre-destruction journal as completed cleanup.

The initial battery verified 5 users, 2 sites and 21 fixture rows. Real roles suite
passed 7/7. The latest buyer read journey passed after correcting explicit cancelled
FX-body handling; smoke remains failing on observed image/dependency errors.
The first 50-test regression failed at Shiplight model setup before actual steps;
a corrected full retry was refused on remaining lifetime. See the frontend's
`specs/qa-disposable/test-report.md` for exact attempts and unfinished coverage.

## Installer retry — 2026-10-27

Published installer `f4e470fc` and schema `5ba907f2` were tested through
`install.sh qa prepare/create` using clean published service snapshots. The first
attempt failed on a removed unversioned Supabase Debian asset URL and its group
was deleted and absence confirmed. Local corrections now resolve the versioned
asset and preinstall tsx once to avoid concurrent worker npx cache corruption.

Fresh Supabase replay exposed three schema portability issues: existing `public`
schema, missing non-login `apps_migration_coordinator` role, and default ACLs owned
by internal `supabase_admin`. Local QA bootstrap corrections handle those without
editing historical migrations or remote production. The corrected replay recorded
145 migrations; `sale_order_items` exists and `sites` has zero rows. Supabase and
Redis became healthy, frontend `/auth` and API `/api/status` returned HTTP 200,
and critical/mail/default workers entered RUNNING.

This attempt includes **unpublished local corrections** in installer and schema;
it is not a pass of the originally published commits alone. The active environment
is `qa-1793126113145-a4b7d0d6`, with external expiry scheduled for 2026-10-27
22:36 UTC (four-hour exact deadline 22:35:34 UTC). Verify actual cleanup after expiry.
No buyer/admin identities or fixtures were provisioned and no E2E, payment,
subscription, email or AI generation calls were executed. HTTP readiness is not
business-flow certification. Secrets and raw logs remain private.

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