# Remediation Queue: implementation specification

Status: design only. Nothing here is implemented. Real credential operations stay disabled; every
execution path in this spec is a simulation until a separate, explicit decision enables an integration.

## 1. Goals and invariants

1. A human decides every step. The Netrunner only proposes.
2. Nothing runs without an approved plan, a stored dry-run preview of that exact plan, and a second,
   explicit execution approval that references the preview.
3. `executionMode` is `simulated` for every run in this release. A global `EXECUTION_ENABLED=false`
   invariant is enforced in the reducer (not only in the Worker), so a Worker bug cannot enable it.
4. A plan or step executes at most once (idempotency, section 6).
5. Every transition is one reducer transaction that also appends to `audit_event` and `security_event`
   (existing pattern), so state and history cannot diverge.
6. Simulated results are never labelled as real completion, in the data model or in the UI.

## 2. States and transitions

Existing statuses: `proposed`, `approved`, `rejected`, `simulated`. The new model replaces `approved`
and `simulated` as end states with a queue lifecycle. Existing rows migrate as noted in section 5.

| State | Meaning | Allowed next states |
|---|---|---|
| `proposed` | Netrunner proposal awaiting a human | `queued`, `rejected`, `revision_requested` |
| `revision_requested` | Human asked for changes; carries a note | `superseded` (a new proposal replaces it), `rejected` |
| `rejected` | Terminal | none |
| `superseded` | Terminal; points to its replacement | none |
| `queued` | Accepted by a human, waiting for a preview | `preview_ready`, `cancelled` |
| `preview_ready` | Dry-run preview stored and hashed | `execution_approved`, `queued` (preview invalidated), `cancelled` |
| `execution_approved` | Human approved this preview hash | `executing`, `cancelled` |
| `executing` | A run holds the lease | `executed`, `failed` |
| `executed` | Run finished; `executionMode` says simulated or real | `verifying` |
| `verifying` | Verification Agent running | `verified`, `verification_failed` |
| `verified` | Terminal for success | none |
| `verification_failed` | Verification found a mismatch or could not confirm | `queued` (new attempt, new preview), `cancelled` |
| `failed` | Execution error | `queued` (new attempt), `cancelled` |
| `cancelled` | Terminal; human or system | none |

Rules:

- Any transition not in the table is rejected (HTTP 409 at the API, `SenderError` in the reducer).
- `proposed -> queued` requires the plan to have at least one step and an `investigationId` whose
  investigation is `completed`.
- A material edit to a plan (steps or action) is not allowed; the user requests a revision and the
  Netrunner creates a new proposal. This keeps the approved object immutable.
- `queued -> preview_ready` is performed by the Worker only; the preview is deterministic text built from
  the plan and current identity state, with no credential or network side effects.
- If the identity's state changes after a preview (new usage event, changed permissions), the Worker
  invalidates the preview (`preview_ready -> queued`) so approval is always for current facts.
- `executed` for a simulated run reads "simulated run complete", never "retired" or "revoked".
  The identity's own `status` is not changed by a simulated run.

## 3. API requirements (Worker)

All routes validate ids (`ID_PATTERN`), bodies (strict shape, size caps) and `actor` (existing rules),
return generic error bodies, and reject unknown transitions with 409. None accepts credential values.

| Route | Purpose | Notes |
|---|---|---|
| `GET /api/remediation-queue` | queued and in-flight plans | filters: `status`, `identityId` |
| `POST /api/remediation-plans/:id/queue` | `proposed -> queued` | body `{actor}` |
| `POST /api/remediation-plans/:id/request-revision` | `proposed -> revision_requested` | body `{actor, note}` (note max 1000 chars) |
| `POST /api/remediation-plans/:id/reject` | existing | |
| `POST /api/remediation-plans/:id/preview` | `queued -> preview_ready` | returns preview and `previewHash` |
| `POST /api/remediation-plans/:id/approve-execution` | `preview_ready -> execution_approved` | body `{actor, previewHash, idempotencyKey}`; hash must match the stored preview |
| `POST /api/remediation-plans/:id/execute` | `execution_approved -> executing -> executed` | simulated only; see section 6 |
| `POST /api/remediation-plans/:id/verify` | starts the Verification Agent | |
| `POST /api/remediation-plans/:id/cancel` | to `cancelled` | allowed from non-terminal pre-execution states |
| `GET /api/remediation-plans/:id/history` | the plan's Afterlife timeline | |

The existing `approve` and `simulate` routes remain until the queue ships, then become aliases:
`approve` maps to `queue`, `simulate` maps to `preview` plus a simulated run, so current clients keep working.

Contract changes go in `packages/shared/src/remediation.ts` (statuses, new fields) and `api.ts`.

## 4. Verification Agent

A separate agent, never the proposing Netrunner, with a read-only toolbox (same scoping rules as the
Netrunner: one identity, schema-validated arguments, no mutating tool). For a simulated run it checks that
the recorded run matches the preview step by step and that no real change was recorded; for a future real
run it would re-read provider state. Output is a structured result (`passed`, per-step `observed` vs
`expected`, `coverage` notes for what could not be checked). It cannot approve, execute or retry.
Model output is untrusted: only the schema-validated fields are stored.

## 5. SpacetimeDB schema requirements

Changes to `remediation_plan` (new columns need `.default(...)` to auto-migrate in place):

| Column | Type | Default | Purpose |
|---|---|---|---|
| `status` | string | existing | extended value set above |
| `queuedAt`, `queuedBy` | option string | none | acceptance |
| `revisionNote` | option string | none | last revision request |
| `supersededBy` | option string | none | replacement plan id |
| `previewHash`, `previewAt` | option string | none | binds approval to a preview |
| `executionApprovedAt`, `executionApprovedBy` | option string | none | second approval |
| `executionMode` | string | `'simulated'` | `simulated` or `real`; real is unreachable in this release |
| `attempt` | u32 | 0 | increments on each new attempt |

New private table `remediation_run` (one row per execution attempt, append-only except for the lease fields):

| Column | Type | Purpose |
|---|---|---|
| `id` | string pk | run id (Worker-generated UUID) |
| `planId` | string, btree index | |
| `attempt` | u32 | |
| `idempotencyKey` | string, unique | duplicate-execution guard |
| `previewHash` | string | what was approved |
| `executionMode` | string | `simulated` or `real` |
| `status` | string | `running`, `succeeded`, `failed` |
| `startedAt`, `finishedAt` | string, option string | |
| `leaseExpiresAt` | string | stale-run recovery |
| `stepResults` | array of `{stepId, status, observed, error}` | results; no secret values |
| `error` | option string | redacted reason |

New private table `verification_result` (`id`, `planId`, `runId`, `status`, `checkedAt`, `checks`, `coverage`).

Rules for the module:

- New reducers each begin with `requireWorker(ctx)`; each validates the transition against the current row,
  writes the audit and security events in the same transaction, and throws `SenderError` otherwise.
- Gated `v_remediation_run` and `v_verification_result` views follow the existing `isAuthorized` pattern.
- The reducer, not the Worker, refuses `executionMode = 'real'` while the compile-time constant
  `EXECUTION_ENABLED` is false.
- Existing rows: `proposed` stays, `rejected` stays, `approved` maps to `queued`, `simulated` maps to
  `executed` with `executionMode='simulated'`. Do this as a one-off owner-run migration reducer or by
  reading old values as aliases in the Worker; never rewrite history rows in `audit_event`.
- New `SecurityEventType` and `AuditAction` values: `remediation-queued`, `remediation-revision-requested`,
  `remediation-superseded`, `remediation-preview-generated`, `remediation-execution-approved`,
  `remediation-execution-started`, `remediation-executed`, `remediation-failed`,
  `remediation-verified`, `remediation-verification-failed`, `remediation-cancelled`.

## 6. Duplicate-execution prevention

1. The client sends an `idempotencyKey` (UUID) with `approve-execution`; the run row's unique constraint
   makes a replay of the same key return the existing run instead of creating another.
2. `execute` claims the run with a lease inside one reducer transaction: it moves `execution_approved ->
   executing` only if no run for that plan is `running` with an unexpired lease. SpacetimeDB reducers are
   serialized and transactional, so two concurrent claims cannot both succeed.
3. A second `execute` on a plan that is `executing`, `executed` or later returns 409 with the existing run id.
4. A crashed run is recovered only after `leaseExpiresAt` passes: the plan moves to `failed` with a
   recorded reason, never auto-retried. A retry is a new attempt that needs a new preview and a new
   execution approval.
5. Steps are individually idempotent in design: each step result is keyed by `(runId, stepId)`.
6. The Worker also keeps the existing per-identity run guard for investigations; it is not relied on for
   remediation.

## 7. User approval rules

- Two distinct approvals: acceptance into the queue (`queue`), then execution approval bound to a
  `previewHash`. Neither implies the other.
- The approver is a person identified by the authenticated principal once user auth exists. Until then
  `actor` is client-supplied and must be labelled as unauthenticated in the audit trail; this is the main
  gap to close before any real execution.
- The execution approval screen shows the exact preview, the identity, the dependencies found, and an
  explicit "simulation only" banner while `executionMode='simulated'`.
- Approvals expire (24 hours proposed) so a stale approval cannot be used against changed facts.
- No bulk approve. No approval by the AI, a tool call, or a webhook.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Preview generation fails | stay `queued`; record `preview-failed` event; user can retry |
| Preview becomes stale | back to `queued`; execution approval voided and logged |
| Step fails during a run | stop at the failed step, run `failed`, remaining steps `skipped`, plan `failed` |
| Worker dies mid-run | lease expiry marks `failed`; no automatic retry |
| Verification cannot confirm | `verification_failed` with `coverage` explaining what was not checked |
| SpacetimeDB rejects a transition (530) | API 409, no partial state; the transition and its events are one transaction |
| SpacetimeDB unreachable or Worker unauthorized | 502, fail closed |
| Retry | always a new `attempt` requiring a fresh preview and approval |

Every failure writes a `security_event` of kind `system` with a redacted reason.

## 9. Security requirements

- Execution adapters live in the Worker behind an interface that is not wired in this release; there is
  no code path from any AI tool to execution. The Netrunner toolbox stays read-only plus `record_finding`
  and `recommend_remediation`.
- All writes go through reducers guarded by `requireWorker`; the service token cannot edit tables directly.
- The preview and step results never contain credential values, only metadata (masked previews, locations).
- Authorization (once user auth exists): separate roles for proposer, approver and executor; a person
  cannot approve their own revision request; execution approver is recorded and shown.
- Rate-limit mutating routes; cap queue size per identity; reject non-JSON and oversized bodies.
- Optimistic concurrency: transitions name the expected current status so a stale UI cannot override a newer state.
- Logs record ids, statuses and timings only.

## 10. Test cases

State machine (module-level and via API):
1. Each allowed transition succeeds once; each disallowed pair returns 409 (full matrix test).
2. `proposed -> approve-execution` directly is rejected.
3. Revision request keeps the original immutable and links the replacement.
4. Terminal states accept no further transitions.

Preview and approval:
5. `approve-execution` with a wrong or missing `previewHash` is rejected.
6. Changing identity facts after preview invalidates it and voids any approval.
7. Expired approval is rejected.

Duplicate prevention:
8. Replaying `approve-execution` with the same `idempotencyKey` returns the same run, no second row.
9. Two concurrent `execute` calls: exactly one 200, one 409, one run row.
10. `execute` on `executed` or `executing` returns 409.
11. Lease expiry marks a stuck run `failed` and never re-executes.

Safety invariants:
12. With `EXECUTION_ENABLED=false`, any attempt to set `executionMode='real'` is rejected in the reducer.
13. A simulated run leaves `machine_identity.status` unchanged and never emits `identity-retired`.
14. No endpoint or agent tool can reach an execution adapter (static check plus a toolbox allow-list test).
15. Anonymous and unregistered callers get 530 on every new reducer and empty rows from every new view
    (extend `spacetime/scripts/verify-access.ts`).

Audit and failure:
16. Every transition writes exactly one `audit_event` and one `security_event` in the same transaction; a
    rejected transition writes neither.
17. Failed step leaves later steps `skipped` and the plan `failed`; retry requires a new preview.
18. Verification disagreement yields `verification_failed`, not `verified`.
19. Migration: old `approved` and `simulated` plans render correctly and no history row changes.

UI:
20. Keyboard-only approval flow; the simulation banner is announced to screen readers; failed and stale
    states are visible and not colour-only.
