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
- ⬜ Real NVIDIA Nemotron inference — still mock-only (`NVIDIA_API_KEY` unset).

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
spacetime publish --server local --module-path . -y credential-reaper
cd ../..

# 4. Run the Worker (reads SPACETIME_URL/SPACETIME_DB_NAME from wrangler.jsonc, matching the above)
pnpm dev:api

# 5. Run the frontend
pnpm dev:web
```

The Worker seeds demo data into SpacetimeDB automatically on its first request (checked against the live database, not re-run on every restart). Open http://localhost:5173.

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

## SpacetimeDB module

`spacetime/module/src/index.ts` defines the tables (machine identities,
permissions, dependencies, credentials metadata, usage events,
investigations, remediation plans, audit events) and reducers
(`startInvestigation`, `completeInvestigation`, `proposeRemediation`,
`simulateRemediation`, plus 5 `seed*` reducers used only for bootstrapping)
that back the Worker API. Useful commands once a local instance is running:

```bash
spacetime describe --server local credential-reaper
curl http://localhost:3000/v1/database/credential-reaper/sql --data "SELECT * FROM machine_identity"
```

**Local dev note:** the published module has no authentication — every table
is public and no reducer checks the caller's identity, so anyone with the
database URL can read and write it. That's fine for local dev but must be
addressed (reducer-level sender checks, and/or a `SPACETIME_AUTH_TOKEN`
secret the Worker already knows how to send) before publishing anywhere
network-reachable.

## Security notes

- No real credentials, API keys, or secrets are ever stored in the database —
  only metadata (masked previews, timestamps, storage location).
- The NVIDIA Nemotron API key lives only in Worker secrets/environment
  variables and is never sent to the frontend.
- Without an API key configured, the Worker falls back to a deterministic
  mock AI provider so the app is fully demoable offline.
- Remediation/retirement actions in this project are **simulated only** —
  nothing ever revokes a real credential.
