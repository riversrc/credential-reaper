# Credential Reaper

AI-powered machine identity investigation and safe credential retirement platform.
Built for HackUTD ZeroDay.

## Stack

- **Frontend:** React + Vite + TypeScript (`apps/web`)
- **Backend API:** Cloudflare Workers (`workers/api`)
- **Database:** SpacetimeDB 2.x TypeScript module (`spacetime/module`)
- **AI:** NVIDIA Nemotron for investigations, with a mock provider for local dev
- **Shared types:** `packages/shared`

## Project layout

```
credential-reaper/
├── apps/web/            React + Vite frontend (The Grid, Identity Details, Investigations, The Afterlife, Remediation)
├── workers/api/         Cloudflare Worker API — reads/writes SpacetimeDB, calls Nemotron (real or mock)
├── spacetime/module/    SpacetimeDB TypeScript server module (tables + reducers)
└── packages/shared/     Shared TypeScript types for API contracts
```

## Status

Built in phases; see git history for what landed at each step.

- ✅ Frontend ↔ Worker: real HTTP calls, configurable via `VITE_API_BASE_URL`.
- ✅ Worker ↔ SpacetimeDB: real HTTP calls (SQL reads + reducer writes), replacing the old in-memory data store. Data persists across Worker restarts.
- ✅ Netrunner agent: Nemotron tool-calling loop (or a scripted mock without a key) investigates through validated backend tools against SpacetimeDB; findings are labeled confirmed / inferred / unknown, risk is computed deterministically, remediation stays proposed for human approval.
- ✅ Live verification of the Nemotron path with a real `NVIDIA_API_KEY`: a real investigation completed with `source: nemotron`, self-directed tool calls, and a proposed remediation plan.

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/) (`corepack enable` or `npm i -g pnpm`)
- The [SpacetimeDB CLI](https://spacetimedb.com/install) — required to actually run the Worker now (see below)

## Setup

```bash
pnpm install
```

## Running everything locally

Three things need to be running, in order:

```bash
# 1. One-time: install the SpacetimeDB CLI
curl -sSf https://install.spacetimedb.com | sh

# 2. Start a local SpacetimeDB instance (leave this running; data persists to disk)
spacetime start --non-interactive

# 3. Publish the module (re-run this whenever spacetime/module/src/index.ts changes)
cd spacetime/module
spacetime publish --server local --module-path . -y <fresh-db-name>   # NOT the existing `credential-reaper` (hardened module gets 403 there)
cd ../..

# 4. Run the Worker (reads SPACETIME_URL/SPACETIME_DB_NAME from wrangler.jsonc, matching the above)
pnpm dev:api

# 5. Run the frontend
pnpm dev:web
```

The Worker seeds demo data into SpacetimeDB automatically on its first request (checked against the live database, not re-run on every restart). Open http://localhost:5173.

## Enabling real Nemotron

Without a key the Worker uses the scripted mock. To use Nemotron, give the Worker a key from [build.nvidia.com](https://build.nvidia.com) — it never reaches the browser:

```bash
# local dev: copy the template, then fill in the key (workers/api/.dev.vars is gitignored)
cp workers/api/.dev.vars.example workers/api/.dev.vars
# set NVIDIA_API_KEY=nvapi-...   (optional: NEMOTRON_MODEL, defaults to nvidia/nemotron-3.5-super-vl-120b-a12b)

# deployed: wrangler secret put NVIDIA_API_KEY
```

Leave `NVIDIA_API_KEY` empty in `.dev.vars` to stay on the mock provider. With a real key set, **every** `POST /api/investigations` calls NVIDIA and uses credits, so use an empty key for UI testing.

## Running the Worker API on its own

```bash
pnpm dev:api
```

Opens on http://localhost:8787 (via `wrangler dev`) — requires a local SpacetimeDB instance running and published as described above. Try it:

```bash
curl http://localhost:8787/api/identities
curl -X POST http://localhost:8787/api/investigations \
  -H 'Content-Type: application/json' \
  -d '{"identityId":"id-005","requestedBy":"you@example.com"}'
```

By default there's no `NVIDIA_API_KEY`, so investigations are answered by the
deterministic mock provider (`workers/api/src/providers/mock.ts`). To use real
NVIDIA Nemotron, set a secret before running `wrangler dev` or deploying:

```bash
cd workers/api
wrangler secret put NVIDIA_API_KEY
```

The key is only ever read server-side in the Worker and is never sent to the
browser.

## Repository Sync (local)

Pipeline: Arasaka repository -> scanner -> Worker ingestion -> SpacetimeDB -> The Grid.
It reads declarations from the repository only. It never invents usage, last-used
times, deployment state or telemetry, never overwrites manually curated ownership,
and never retires a credential (a declaration that disappears is flagged
"Removed from repo", nothing more).

```bash
# 1. Scan the Arasaka repo (branch `demo`) to JSON, no network or database needed
cd workers/api
node scripts/scan-repo.ts /home/riversrc/credential-reaper-demo-app --out /tmp/scn/scan.json

# 2. Ingest it into a running Worker (idempotent: re-running adds nothing).
#    INGEST_TOKEN must equal the Worker's INGEST_TOKEN secret (.dev.vars locally)
INGEST_TOKEN=... node scripts/ingest-scan.ts /tmp/scn/scan.json --api http://localhost:8787

# 3. Open The Grid; repository identities carry a REPO tag, seeded ones a DEMO tag
```

Endpoints: `POST /api/repository/scans` (requires `Authorization: Bearer $INGEST_TOKEN`, 401 without it, 503 while the Worker has no `INGEST_TOKEN`; validates, then persists; 400
`invalid_scan` on malformed or unsupported data, 413 over 500 identities, 409 while another scan of the repo is running), `GET /api/repository/scans`
(scan history), `POST /api/identities/:id/ownership` (set a curated owner, or
`{"revert":true}` to follow the repository again). Identity details include a
`repository` block with the commit SHA, source paths, evidence types and confidence.

Browser-facing POSTs require `Content-Type: application/json` (else 415) and, if an
`Origin` header is sent, one listed in `ALLOWED_ORIGINS` (comma-separated; default
`http://localhost:5173,http://localhost:5174`; else 403). Requests without `Origin` (curl, scripts) pass.
The audit `actor` for ownership and remediation actions is the fixed label `web-operator`; a body `actor` is ignored.

### Remediation as a pull request

For a `retire` plan on an identity the repository declares as `declared-only`, an approved plan can be turned
into a real GitHub pull request. `POST /api/remediation-plans/:id/pr-preview` is read-only: it fetches the head
of `GITHUB_SYNC_BRANCH`, builds the change that removes the identity's declaration, permission and ownership
records and its bindings in the owning service, and verifies it by re-scanning the changed repository in memory
(exactly that identity's records must disappear, nothing else). `POST /api/remediation-plans/:id/open-pr`
then commits that change to a new `reaper/retire-<name>-<plan>` branch and opens a pull request into the
synced branch, using `GITHUB_PR_TOKEN`, a separate fine-grained token with Contents and Pull requests write on
the one repository (503 while unset; the read-only `GITHUB_TOKEN` is never used to write). The pull request
changes configuration only: it never revokes, rotates or deletes a credential, the base branch is never written,
and a person merges it. Merging triggers the push webhook, which marks the identity `removed` (never `retired`).
Active identities and anything the layout check does not recognise are refused with a 409.

Tests: `cd workers/api && pnpm test:pr` (change equals the scenario patch, refusals, fake-GitHub flow; no services);
with `PR_TEST_API` and friends set it also runs end to end through a Worker on a test database (see the top of
`scripts/test-remediation-pr.ts`).

### GitHub push webhook

A push to the tracked branch of the Arasaka repo triggers the same scan and ingest, so new machine
identities show up without running the CLI. `POST /api/webhooks/github` is authenticated only by GitHub's
HMAC signature (`X-Hub-Signature-256`, secret `GITHUB_WEBHOOK_SECRET`; 503 while unset, 401 on a bad
signature). It answers 202 right away, downloads the pushed commit as one tarball, scans it, and ingests it
in the background. Each ingest writes an audit and security event that names the new identities and the
commit, for example `New identities (1): analytics-report-publisher. Triggered by push 3a1f9c2 by river.`

To connect it locally: expose the Worker (for example `cloudflared tunnel --url http://localhost:8788`), then in
the GitHub repo add a webhook with Payload URL `<public-url>/api/webhooks/github`, content type
`application/json`, the secret from `.dev.vars`, and "Just the push event". Set `GITHUB_SYNC_BRANCH` to the
branch you push to. The scanned repo name (`owner/name`) must match the one already ingested, because the
module refuses to let a different repository take over an identity.

Tests: `cd workers/api && pnpm test:webhook` runs signature, payload and tarball tests with no services; with
`WEBHOOK_TEST_API` set it also runs an end-to-end test against a Worker started with a fake GitHub (see the top
of `scripts/test-github-webhook.ts`). That test adds a scenario identity, so point it at a test database.

Tests: `cd workers/api && pnpm test:scan` (scanner, no services needed) and
`INGEST_TEST_API=http://localhost:8787 pnpm test:ingest` (end to end against a
running Worker + SpacetimeDB; it writes to that database, so point it at a
test/sync database).

Caveats: an ingest makes roughly 60 reducer calls, which is fine locally but
exceeds the Cloudflare free-plan subrequest limit when deployed. For repository
identities, status `active` means "not flagged by repository ownership data", not
a runtime state. The ownership control accepts an unauthenticated, client-supplied
actor, in line with the no-auth note below.

## SpacetimeDB module

`spacetime/module/src/index.ts` defines the tables (machine identities,
permissions, dependencies, credentials metadata, usage events,
investigations, remediation plans, audit events) and reducers
(`startInvestigation`, `completeInvestigation`, `proposeRemediation`,
`simulateRemediation`, `recordRemediationPr`, plus 5 `seed*` reducers used only for bootstrapping)
that back the Worker API, plus the Repository Sync tables (`repo_scan`,
`repo_record`) and reducers (`beginRepoScan`, `ingestRepoRecords`,
`syncRepoIdentity`, `finishRepoScan`, `setIdentityOwnership`) — 12 tables and
20 reducers in total (including a few not listed here that predate Repository Sync). Useful commands once a local instance is running:

```bash
spacetime describe --server local credential-reaper
spacetime sql --server local credential-reaper "SELECT * FROM machine_identity"   # owner only; tables are private
```

**Database access model.** Every table is private and every reducer begins with
a check that the caller is registered in the private `authorized_caller` table.
The Worker reads through gated `v_*` views and writes through reducers using a
dedicated service identity; an anonymous caller sees no rows and every reducer
call is rejected. After publishing the module, provision that identity once
(run as the database owner), then give the token to the Worker:

```bash
spacetime/scripts/provision-worker-identity.sh credential-reaper ~/.credential-reaper-worker-token
# put the file's content in workers/api/.dev.vars as SPACETIME_AUTH_TOKEN=...
node spacetime/scripts/verify-access.ts anon credential-reaper      # ALLOW_MAIN_DB=1 required for the main DB
```

Without a token the Worker fails closed (HTTP 502). Application-level user
authentication and Worker rate limiting do not exist yet.

## Security notes

- No real credentials, API keys, or secrets are ever stored in the database —
  only metadata (masked previews, timestamps, storage location).
- The NVIDIA Nemotron API key lives only in Worker secrets/environment
  variables and is never sent to the frontend.
- Without an API key configured, the Worker falls back to a deterministic
  mock AI provider so the app is fully demoable offline.
- Remediation/retirement actions in this project are **simulated only** —
  nothing ever revokes a real credential.
