# CLAUDE.md

Development instructions for Claude Code (and human developers) working on **Credential Reaper**. This file documents the repository's actual current state as of the initial scaffold. Keep it updated as the architecture evolves — do not let it drift into aspirational documentation.

## 1. Project Overview

Credential Reaper is an AI-powered **machine identity investigation and safe credential retirement platform**, built for HackUTD ZeroDay.

**The problem:** organizations accumulate machine identities over time — service accounts, API keys, OAuth apps, certificates, SSH keys, bots, webhooks — many of which outlive their purpose. Owners leave, services get migrated, contracts end, and the credential is never revoked. These orphaned or stale identities are a quiet but serious security risk: broad permissions, no owner, no monitoring.

**What it does:** gives security teams an inventory of machine identities, lets them run an AI-assisted "investigation" into a specific identity (ownership, dormancy, over-permissioning), and proposes a remediation plan (retire / rotate / migrate / monitor) that can be **simulated** as a safe dry run.

**Terminology** (also see "The 5 pages" below):
- **Machine identity** — any non-human credential holder: `service-account`, `api-key`, `oauth-app`, `ssh-key`, `certificate`, `bot-account`, `webhook`.
- **Investigation** — an AI-assisted analysis of one identity, producing `findings` + a `recommendedAction`.
- **Finding** — a single risk observation from an investigation (e.g. "no active owner"), with a `severity`.
- **Remediation plan** — a proposed `retire` / `rotate` / `migrate` / `monitor` action with ordered `steps`.
- **Simulation** — marking a remediation plan as dry-run complete. **Never** touches a real credential.
- **Audit event** — an entry in "The Afterlife" timeline; the record of what happened and when.
- **The Grid**, **The Afterlife** — in-app names for the inventory page and the audit history page, respectively.

## 2. Technology Stack

Actual versions currently pinned in this repo (see each `package.json` for the source of truth):

| Area | Technology | Version |
|---|---|---|
| Frontend | React | ^19.3.1 |
| Frontend | Vite | ^8.3.6 |
| Frontend | react-router-dom | ^7.1.1 |
| Language | TypeScript | ~7.0.2 (web), ^5.7.2 (api, shared, spacetime module) |
| Monorepo | pnpm workspaces | pnpm 12.x (see root `pnpm-workspace.yaml`) |
| Backend | Cloudflare Workers | `wrangler` ^4.158.0, `@cloudflare/workers-types` ^5.x |
| Database | SpacetimeDB | `spacetimedb` npm package ^2.14.0 (server module), `spacetime` CLI 2.14.1 (standalone server + publish tooling) |
| AI | NVIDIA Nemotron | via NVIDIA Build's OpenAI-compatible endpoint (`https://integrate.api.nvidia.com/v1/chat/completions`), native `tools`/`tool_calls` function calling, default model `nvidia/nemotron-3-super-120b-a12b`, no SDK — plain `fetch` |

No ORM, no Postgres, no D1, no Redis. SpacetimeDB is the only database. `packages/shared` has no build step — it's consumed directly as TypeScript source via workspace linking (its `main`/`types` point at `src/index.ts`).

The Worker talks to SpacetimeDB over its plain HTTP API (`/v1/database/:db/sql` for reads, `/v1/database/:db/call/:reducer` for writes) via `workers/api/src/spacetime/client.ts` — **not** the WebSocket client SDK (`spacetimedb/sdk`). That SDK is built around a persistent connection + local subscription cache, which is a poor fit for a Workers isolate that may be evicted between requests; plain request/response HTTP calls match the Worker's existing per-request model with no new infrastructure.

## 3. Repository Structure

```
credential-reaper/
├── apps/web/            React + Vite frontend
├── workers/api/         Cloudflare Worker API
├── spacetime/module/    SpacetimeDB TypeScript server module
└── packages/shared/     Shared TypeScript types (no build step; consumed as source)
```

**`apps/web`** — the frontend. Key paths:
- `src/pages/` — `TheGrid.tsx`, `IdentityDetails.tsx`, `Investigations.tsx`, `TheAfterlife.tsx`, `Remediation.tsx`, one per route.
- `src/components/` — `Layout.tsx` (sidebar nav + `<Outlet/>`), `Badges.tsx` (risk/status pill components).
- `src/api/client.ts` — makes real `fetch` calls to `workers/api` (base URL from `VITE_API_BASE_URL`, default `http://localhost:8787`). Function signatures (`fetchIdentities`, `fetchIdentityDetail`, `startInvestigation`, etc.) match the shared `ApiRoutes` contract; pages call these, never `fetch` directly.
- `src/App.tsx` / `src/main.tsx` — routing (`react-router-dom`, `BrowserRouter`) and app entry.

**`workers/api`** — the Cloudflare Worker. Key paths:
- `src/index.ts` — the entire fetch handler. Manual routing by `pathname`/`method` (no router library) implementing the routes in `packages/shared/src/api.ts`. CORS enabled for all origins (dev-friendly, revisit before any real deployment). Calls `ensureSeeded(env)` once per request (cheap no-op after the first success) before routing, then delegates all reads/writes to `src/spacetime/repository.ts` — there is no more in-memory data store in the Worker.
- `src/spacetime/client.ts` — low-level SpacetimeDB HTTP client: `sqlQuery()` (SELECT, decodes SpacetimeDB's positional/algebraic row format into camelCase objects), `callReducer()` (the only way to write), `sqlString()` (literal escaping for the SQL endpoint, which takes raw text with no bind params), `encodeOption()` (wraps a nullable value as `{some: v}` / `{none: {}}` for Option-typed reducer args).
- `src/spacetime/repository.ts` — domain-level functions (`fetchIdentities`, `fetchIdentityDetail`, `startInvestigationRow`, `simulateRemediationRow`, etc.) that `index.ts` calls instead of touching SpacetimeDB directly. Also owns `ensureSeeded()`, which bootstraps demo data into a freshly published module exactly once, checked against the live `machine_identity` table (not a Worker-local flag) so it's safe across isolate restarts.
- `src/spacetime/seed-data.ts` — the demo dataset (4 identities + related rows, 1 investigation, 1 remediation plan) that `ensureSeeded()` writes through the real reducers on first run. This is the same content that used to live in the now-deleted `src/data.ts`.
- `src/agent/` — the **Netrunner** investigation agent:
  - `tools.ts` — the controlled tool surface (`createToolbox`): `get_identity_details`, `get_ownership`, `get_permissions`, `get_dependencies`, `get_usage_history`, `get_risk_assessment`, `record_finding`, `recommend_remediation`. The model only *requests* tools; every call is JSON-parsed, schema-validated, scoped to the identity under investigation (any other `identity_id` is rejected), executed against SpacetimeDB, and traced. `record_finding` for `confirmed`/`inferred` findings must cite retrieval tools that were actually called and quote a value from their results; `unknown` findings need no sources. `recommend_remediation` only creates a `proposed` plan with deterministic, non-automatable steps. There is no tool that touches a real credential.
  - `risk.ts` — deterministic risk score/level/factors and a suggested action, computed by the Worker from SpacetimeDB rows. The AI never sets or edits risk.
  - `investigate.ts` — `runInvestigation()`: persists the running row, runs the provider, recomputes risk itself, finalizes (or marks the investigation `failed`).
- `src/providers/` — the AI provider behind the agent:
  - `nemotron.ts` — real agent loop over NVIDIA's chat completions API. Limits (`LIMITS`): 10 turns, 24 tool calls (8 per turn), 60s per request, 180s total; the last turn forces `tool_choice: "none"`; one retry on 429/5xx/network error; errors are redacted of the API key. Never logs message content or the key.
  - `mock.ts` — scripted agent used automatically with no API key. It makes the same tool calls through the same toolbox (so it reads real SpacetimeDB data) but decides findings with fixed rules.
  - `index.ts` — `getAiProvider(env)` picks real vs. mock by `env.NVIDIA_API_KEY`; `types.ts` holds the provider contract. If the real provider fails mid-run the investigation is marked `failed` (HTTP 502) — it does **not** silently fall back to the mock.
- `wrangler.jsonc` — Worker config. `SPACETIME_URL` / `SPACETIME_DB_NAME` are plain `vars` (not secret — just a local hostname and a database name) defaulting to a local `spacetime start` instance. `NVIDIA_API_KEY`, and optionally `SPACETIME_AUTH_TOKEN`, are read as secrets, never committed.

**`spacetime/module`** — the SpacetimeDB server module. Single file, `src/index.ts`:
- Defines tables: `machineIdentity`, `permissionGrant`, `identityDependency`, `credentialMetadata`, `usageEvent`, `investigation`, `remediationPlan`, `auditEvent`.
- Defines reducers: `startInvestigation`, `recordFinding`, `completeInvestigation`, `failInvestigation`, `proposeRemediation`, `simulateRemediation`, plus 5 seed reducers (`seedIdentity`, `seedPermission`, `seedDependency`, `seedCredential`, `seedUsageEvent`) — the only way to write the "static inventory" tables, added specifically so the Worker's `ensureSeeded()` has something to call.
- Written against the real `spacetimedb` npm package's `schema()` / `table()` / `t` / `.reducer()` API (function-based schema definition, not decorators). **Published and connected** — see Architecture below for how to run it yourself.

**`packages/shared`** — shared TypeScript types, one file per domain concern: `identity.ts`, `investigation.ts`, `remediation.ts`, `audit.ts`, `nemotron.ts` (AI provider contract), `api.ts` (the `ApiRoutes` contract the Worker is meant to implement and the frontend is meant to call). `index.ts` re-exports everything.

**Other notable files:**
- Root `package.json` — workspace-wide scripts (`dev:web`, `dev:api`, `typecheck`, `build:web`, `build:shared`). **Note:** `build:shared` currently has no corresponding `build` script in `packages/shared/package.json` and will fail if run — see §8.
- `pnpm-workspace.yaml` — workspace globs plus `allowBuilds` (approves `esbuild`/`workerd` postinstall scripts, required for `wrangler`/Vite tooling) and a `minimumReleaseAgeExclude` entry for `@cloudflare/workers-types`.
- `README.md` — setup/run instructions and a status checklist; keep it and this file in sync.

## 4. Architecture

**Current data flow (fully connected, verified end to end):**

```
apps/web (React)  --HTTP-->  workers/api (Cloudflare Worker)  --HTTP-->  SpacetimeDB (local `spacetime start`)
                                      |                                   running the published spacetime/module
                                      +--fetch-->  NVIDIA Nemotron API
```

All three runtime pieces import types from `packages/shared` so the contract stays consistent end to end. The Worker talks to SpacetimeDB via plain HTTP (`workers/api/src/spacetime/client.ts`), not the WebSocket client SDK — see §2 for why.

**What currently works (verified):**
- The full chain: frontend → Worker → SpacetimeDB, for every route — identity inventory, identity details, investigations (start + list + results), audit events, and remediation simulate. Verified by curling the Worker directly, by querying SpacetimeDB directly to confirm persistence independent of the Worker's response, and by driving the actual frontend pages in a browser.
- **Persistence across Worker restarts**: killed and restarted `wrangler dev` mid-session; a previously-started investigation and a previously-simulated remediation plan were both still present afterward, and no duplicate seed data was inserted (the emptiness check in `ensureSeeded()` is authoritative against the live table, not a Worker-local flag).
- The Netrunner agent end to end with the **mock** provider (no API key needed): tool calls read real SpacetimeDB data, findings are appended through `record_finding`, risk is computed by the backend, a `proposed` remediation plan is created, and the frontend displays basis/risk/tool trace.
- The real Nemotron agent loop, exercised against a **fake** NVIDIA endpoint (`workers/api/scripts/test-nemotron-loop.ts`, run with `cd workers/api && npx tsx scripts/test-nemotron-loop.ts`; needs local SpacetimeDB). It verifies the request shape we send, tool validation/rejection, bounds, failure handling and key redaction against real SpacetimeDB.
- A local SpacetimeDB instance is running in this dev environment: `spacetime` CLI installed via the official installer, `spacetime start` running as a background process (data directory `~/.local/share/spacetime/data`, persists across its own restarts since `--in-memory` was not used), with the `spacetime/module` code published as database `credential-reaper`.

**What still uses mock/synthetic data:** with `NVIDIA_API_KEY` unset (the default) investigations use the scripted mock provider.

**What has NOT been verified:**
- Calls to the *real* NVIDIA endpoint with a valid key. NVIDIA authenticates before validating the body, so the request shape (`tools`, `tool_choice`, `max_tokens`, no reasoning params) is checked only against NVIDIA's docs and the fake-endpoint test, not live. Real-model behavior (does it call tools sensibly, does `nemotron-3-super` keep reasoning output out of `content`) is unobserved. Only the bad-key path (HTTP 403 → failed investigation) was verified live.

**To run this yourself, in order:**
1. Install the SpacetimeDB CLI: `curl -sSf https://install.spacetimedb.com | sh` (prebuilt binary, no Rust toolchain needed).
2. Start a local instance: `spacetime start --non-interactive` (listens on `0.0.0.0:3000` by default; leave it running in its own terminal/background process).
3. Publish the module: `cd spacetime/module && spacetime publish --server local --module-path . -y credential-reaper`. Re-run this (same command) any time `spacetime/module/src/index.ts` changes — it updates the existing database in place unless the schema change is breaking.
4. `pnpm dev:api` — the Worker reads `SPACETIME_URL`/`SPACETIME_DB_NAME` from `wrangler.jsonc`'s `vars` (defaults already match steps 1–3) and seeds demo data into the database automatically on its first request.
5. `pnpm dev:web` as before.

**Known limitation — no auth on the local module:** every table is `{public: true}` and no reducer checks `ctx.sender`, so **any** caller with the database URL can read and write it (confirmed: all testing above used fully anonymous requests, no token). Fine for local dev; if this module is ever published somewhere network-reachable (e.g. SpacetimeDB Maincloud), it is effectively an open database until reducers add sender-identity checks or the Worker is given a private `SPACETIME_AUTH_TOKEN` secret and the module is changed to require it (the client already supports sending one if set — see `authHeader()` in `client.ts` — but nothing currently populates or requires it). Treat this the same way as the existing "CORS allows `*`" caveat: acceptable now, must be addressed before any real deployment.

**Still requires deployment or configuration for anything beyond this local setup:**
- `wrangler secret put NVIDIA_API_KEY` (and optionally `NEMOTRON_MODEL`) to use real Nemotron instead of the mock. For local `wrangler dev`, put `NVIDIA_API_KEY=...` in `workers/api/.dev.vars` (gitignored).
- A real Cloudflare account + `wrangler deploy` for anything beyond local `wrangler dev`.
- A SpacetimeDB Maincloud account (or a persistently-hosted `spacetime start` instance) + the auth hardening above, for anything beyond local dev.
- CORS currently allows `*` — tighten before any public deployment.

## 5. Coding Standards

- Prefer TypeScript everywhere; all three runtime packages are `strict: true`.
- Keep code modular and readable over clever. This is a hackathon-scale codebase — small, direct functions beat premature abstraction.
- Reuse types from `packages/shared` instead of re-declaring shapes locally. If a type is needed in more than one package, it belongs in `packages/shared`.
- Avoid unnecessary dependencies — no router/framework was added to the Worker (plain `fetch` handler); no state management library in the frontend (local `useState`/`useEffect` is enough so far).
- Avoid unnecessary abstractions: the Worker uses manual `pathname` matching rather than a routing library; data clients are plain async functions, not classes or generic repositories.
- Follow existing conventions: one page per route file in `apps/web/src/pages`, one provider implementation per file in `workers/api/src/providers`, one domain concern per file in `packages/shared/src`.
- No comments restating what code does; comments only for non-obvious constraints (see existing files for the expected density/style).

## 6. Security Requirements

- **Never commit secrets or API keys.** `NVIDIA_API_KEY` is read from Worker env/secrets only (`wrangler secret put`); it is not in any committed file. `.gitignore` excludes `.env*` (except `.env.example`) and `.wrangler/`.
- **Never expose NVIDIA credentials to the browser.** All Nemotron calls happen server-side in `workers/api/src/providers/nemotron.ts`; the frontend never sees the key.
- **Never store raw passwords, API keys, or tokens.** `CredentialMetadata` (shared type + `workers/api/src/spacetime/seed-data.ts`) stores only `maskedPreview` (e.g. `sk-live-****7f2a`), `storageLocation`, and timestamps — never a real secret value.
- **Validate backend inputs.** The Worker still does minimal validation on POST bodies (e.g. `StartInvestigationRequest`) and on values interpolated into SQL text (`sqlString()` escapes embedded quotes, but there's no schema/shape validation of request bodies) — tighten this before any real deployment; don't trust `identityId`/`requestedBy` blindly.
- **Sanitize logs and AI tool outputs.** Treat Nemotron responses as untrusted text: tool-call arguments are `JSON.parse`d and validated before anything runs, the final summary is stripped of `<think>`/`<tool_call>` blocks and rendered as plain text (never HTML), and structured logs record tool names/status/timing only — never message content, tool results or the API key.
- **Agent tool calls are untrusted requests.** The toolbox validates arguments, scopes every call to the identity under investigation, caps sizes/counts, and exposes no credential-mutating tool. Tool results and identity text are treated as data, not instructions (stated in the system prompt). Risk scores are computed only in `agent/risk.ts`. Never add a tool that revokes/rotates/deletes anything; remediation stays `proposed` until a human acts.
- **Never execute destructive real-world credential operations in the MVP.** `simulateRemediation` only flips `status` to `"simulated"` and timestamps it — it must never call a real IdP/secrets manager to revoke anything. Keep this invariant even once real persistence/integrations are added.

## 7. Database Guidelines

SpacetimeDB 2.x TypeScript server module, defined entirely in `spacetime/module/src/index.ts` using the real `spacetimedb` package's **function-based** schema API (not decorators):

```ts
import { schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  machineIdentity: table(
    { public: true },
    { id: t.string().primaryKey(), /* ... */ }
  ),
  // ...
});
export default spacetimedb;

export const startInvestigation = spacetimedb.reducer(
  { id: t.string(), identityId: t.string(), /* ... */ },
  (ctx, { id, identityId /* ... */ }) => {
    ctx.db.investigation.insert({ /* ... */ });
  }
);
```

**Current schema** (8 tables, all `public: true`): `machineIdentity`, `permissionGrant`, `identityDependency`, `credentialMetadata`, `usageEvent`, `investigation`, `remediationPlan`, `auditEvent`. Nested arrays (`findings`, `steps`) are modeled with `t.object('Name', {...})` + `t.array(...)`. `permissionGrant`, `identityDependency`, `credentialMetadata`, `usageEvent`, `investigation`, `remediationPlan` each have a `byIdentity` btree index on `identityId`; `auditEvent` has a `byTimestamp` btree index.

**Current reducers** (11): `startInvestigation`, `recordFinding` (appends one finding as the agent records it), `completeInvestigation` (summary, recommendation, deterministic risk, tool trace — findings are already recorded), `failInvestigation`, `proposeRemediation`, `simulateRemediation` (the real app-logic reducers), plus `seedIdentity`, `seedPermission`, `seedDependency`, `seedCredential`, `seedUsageEvent` (bootstrap-only — the only way to write the 5 "static inventory" tables, since nothing in the app creates/edits them yet). All IDs are supplied by the caller (not generated inside the reducer) — reducers must be deterministic, so don't reach for `crypto.randomUUID()`/`Date.now()` inside one; generate IDs/timestamps in the caller (the Worker) and pass them in, as every reducer does.

**How the Worker talks to a published module (verified against a real local instance, not guessed):**
- Table/column/reducer names are the camelCase TS names auto-converted to snake_case on the wire (`machineIdentity` → `machine_identity`, `riskLevel` → `risk_level`, `startInvestigation` → `start_investigation`). Confirmed via `spacetime describe --server local credential-reaper`.
- **Reads** go through `POST /v1/database/:db/sql` with the raw SQL text as the body (not JSON, and **only one statement per request** — `;`-separated batches are rejected). The response is `[{schema: {elements: [...]}, rows: [[...]]}]`: each row is a **positional array** matching `schema.elements` order, not an object — `workers/api/src/spacetime/client.ts`'s `decodeRow()` zips them into camelCase objects. Option columns decode as a 2-tuple: `[0, value]` for present, `[1, []]` for absent.
- **Writes** go through `POST /v1/database/:db/call/:reducer_name`. Unlike SQL reads, this endpoint accepts a plain **JSON object with camelCase keys** matching the reducer's TS param names directly (no snake_case conversion needed in the request body) — confirmed by calling reducers with both positional-array and named-object bodies; the named-object form is what this codebase uses everywhere, since it's far less brittle than relying on param declaration order. Any `Option<T>` reducer argument must be wrapped as `{some: value}` or `{none: {}}` — a bare `null`/omitted key is rejected with a 400. `client.ts`'s `encodeOption()` does this.
- Anonymous requests (no `Authorization` header) work for both endpoints as long as the module's tables are `public: true` and its reducers don't check `ctx.sender` — true for every table/reducer here today. See §4's "Known limitation" note before relying on this anywhere but local dev.
- The SQL endpoint only supports `SELECT` — mutations must go through reducers. (A raw `INSERT`/`UPDATE` is parsed and will even get partway through validation before failing on `Option` literal syntax, which is not documented; don't rely on it.)

- **Nested object fields in reducer args use snake_case** (`duration_ms`), unlike top-level args which accept camelCase. `repository.ts`'s `encodeTrace()` handles this; reads still come back through `decodeRow()` as camelCase.
- **Schema evolution:** `investigation` gained `riskScore`, `riskLevel`, `riskFactors`, `findingBases`, `toolTrace` columns with `.default(...)`, which SpacetimeDB auto-migrates in place (existing rows kept). Because the nested `Finding` object can't gain a field without a breaking migration, each finding's `basis` lives in the parallel `findingBases` array (`findingBases[i]` ↔ `findings[i]`); `repository.ts` merges them. Rows predating this (seeded `inv-001`) default to `confirmed`.

**Conventions to follow:**
- Timestamps are stored as ISO 8601 **strings**, not SpacetimeDB's native `Timestamp` type — this is deliberate, to keep row shapes identical to `packages/shared` types and avoid conversion at the Worker boundary. Keep this convention unless you change it everywhere at once.
- Optional fields use `t.option(...)`. In the module's own TS code this is `T | undefined`; the Worker's `decodeRow()` normalizes it to `T | null` on the way out (matching `packages/shared`'s convention) and `encodeOption()` converts `T | null | undefined` back to the wire's `{some}`/`{none}` shape on the way in. The conversion is isolated to `workers/api/src/spacetime/client.ts` — don't duplicate it elsewhere.
- Do not invent SpacetimeDB APIs. If you need a method/shape not already used in `spacetime/module/src/index.ts`, verify it against the installed `spacetimedb` package's actual `.d.ts`/`.ts` source (`node_modules/spacetimedb/dist/server/*.d.ts` or `src/`), or against a real running instance with `spacetime describe`/`spacetime sql`/`curl`, before using it.
- After changing `spacetime/module/src/index.ts`, republish before testing the Worker: `cd spacetime/module && spacetime publish --server local --module-path . -y credential-reaper`.

## 8. Testing

No automated test suite exists yet (no test runner configured in any package), apart from one manual integration script for the Nemotron agent loop (`workers/api/scripts/test-nemotron-loop.ts`, see §4; it creates test investigations in the local database). Commands that actually exist today:

```bash
# Install all workspace dependencies (run from repo root)
pnpm install

# One-time: install the SpacetimeDB CLI
curl -sSf https://install.spacetimedb.com | sh

# Start a local SpacetimeDB instance (leave running; data persists to disk)
spacetime start --non-interactive

# Publish/update the module against it (re-run after editing spacetime/module/src/index.ts)
cd spacetime/module && spacetime publish --server local --module-path . -y credential-reaper

# Run the Worker locally via wrangler dev (http://localhost:8787) — requires the above two steps first
pnpm dev:api

# Run the frontend dev server (http://localhost:5173)
pnpm dev:web

# Typecheck every package that defines a "typecheck" script
pnpm typecheck

# Production build of the frontend only
pnpm --filter @credential-reaper/web build
```

Useful one-off commands for inspecting the live database directly, bypassing the Worker:

```bash
spacetime describe --server local credential-reaper          # tables/reducers/types
curl http://localhost:3000/v1/database/credential-reaper/sql --data "SELECT * FROM machine_identity"
```

Verified manually (not via an automated suite): frontend pages via browser interaction; Worker routes via `curl` against a running `wrangler dev` instance backed by a real local SpacetimeDB instance; persistence verified by killing and restarting `wrangler dev` and confirming prior state (including a started investigation and a simulated remediation plan) was still present with no re-seeding.

**Known broken command:** `pnpm build:shared` (defined at the repo root) fails — `packages/shared/package.json` has no `build` script. Either add one (if shared ever needs a compiled output) or remove the root script; don't assume it works.

## 9. Git Workflow

- Use feature branches for independent work; do not commit directly to `main` for normal feature development.
- Write descriptive commit messages (see existing history for the expected tone/detail — each commit explains *why*, not just *what*).
- Review changes before merging — read the diff, not just the summary.
- Avoid overwriting another developer's in-progress work: check `git status`/`git log` before broad edits, and prefer small, reviewable commits over one large one.

## 10. MVP Priorities

1. ✅ Connect the React frontend to the actual Worker API — done; `apps/web/src/api/client.ts` makes real `fetch` calls to `workers/api` via `VITE_API_BASE_URL`.
2. ✅ Publish and configure the SpacetimeDB module — done for local dev (`spacetime start` + `spacetime publish --server local`); not published anywhere persistent/public (no Maincloud account configured).
3. ✅ Connect the Worker to SpacetimeDB so persistent data is used — done; `workers/api/src/data.ts` is deleted, all reads/writes go through `workers/api/src/spacetime/`.
4. ⚠️ Real NVIDIA Nemotron agent — implemented (tool-calling loop in `workers/api/src/providers/nemotron.ts`, tools in `src/agent/`), tested against a fake endpoint, **not yet verified with a live key** (set `NVIDIA_API_KEY`, run an investigation, inspect the tool trace). **Next up.**
5. ✅ Complete the investigation flow end-to-end on real data — verified: start → mock AI call → persisted in SpacetimeDB → visible in the frontend, survives Worker restarts.
6. ✅ Complete audit history and simulated remediation end-to-end on real data — verified the same way.
7. Improve the visual design only after the above functionality is verified working.
8. Before any deployment beyond local dev: address the "no auth on the local module" limitation in §4, and the existing CORS-allows-`*` note.

## 11. Development Rules

- Always inspect existing code before modifying it — read the relevant file(s) in full, don't guess from this document alone (it will go stale).
- Do not rewrite working functionality unnecessarily. The frontend, Worker, and SpacetimeDB module are all connected and working today; further changes (e.g. real Nemotron) mean swapping one piece at a time, not redesigning pages, routes, or the schema.
- Do not assume an integration works until it has been tested (manually is fine at this stage; there's no test suite yet).
- Prefer small, focused changes over large rewrites.
- Keep frontend, backend, and database contracts consistent — when a shape in `packages/shared` changes, update all three consumers (`apps/web`, `workers/api`, `spacetime/module`) in the same change.
- Update this file and `README.md` when the architecture changes (e.g. once Frontend↔Worker or Worker↔SpacetimeDB integration lands, move the relevant bullet from "not yet integrated" to "works").
