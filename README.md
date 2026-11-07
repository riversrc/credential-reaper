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
├── workers/api/         Cloudflare Worker API (currently serves seed data + mock/real Nemotron)
├── spacetime/module/    SpacetimeDB TypeScript server module (tables + reducers, not yet wired to the Worker)
└── packages/shared/     Shared TypeScript types for API contracts
```

## Status

Built in phases; see git history for what landed at each step.

- ✅ Frontend: all 5 pages working end-to-end against synthetic data.
- ✅ Worker API: routes matching the shared contract, backed by in-memory
  seed data, with a working mock AI provider (and real Nemotron support if
  `NVIDIA_API_KEY` is set).
- ✅ SpacetimeDB module: tables + reducers defined and typechecked.
- ⬜ Worker ↔ SpacetimeDB integration (Worker still uses in-memory data).
- ⬜ Frontend ↔ Worker integration (frontend still uses its own synthetic data client).

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/) (`corepack enable` or `npm i -g pnpm`)
- For the SpacetimeDB module: the [SpacetimeDB CLI](https://spacetimedb.com/install) (not required for the frontend or Worker)

## Setup

```bash
pnpm install
```

## Running the frontend

```bash
pnpm dev:web
```

Opens on http://localhost:5173. The frontend currently runs against synthetic
in-memory data (`apps/web/src/data`, `apps/web/src/api/client.ts`) so it works
fully offline, including "starting" investigations and "simulating"
remediation plans.

## Running the Worker API

```bash
pnpm dev:api
```

Opens on http://localhost:8787 (via `wrangler dev`). Try it:

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
`simulateRemediation`) that will eventually back the Worker API. It typechecks
against the real `spacetimedb` package but requires the SpacetimeDB CLI to
actually run or publish:

```bash
cd spacetime/module
spacetime dev
```

## Security notes

- No real credentials, API keys, or secrets are ever stored in the database —
  only metadata (masked previews, timestamps, storage location).
- The NVIDIA Nemotron API key lives only in Worker secrets/environment
  variables and is never sent to the frontend.
- Without an API key configured, the Worker falls back to a deterministic
  mock AI provider so the app is fully demoable offline.
- Remediation/retirement actions in this project are **simulated only** —
  nothing ever revokes a real credential.
