# The Afterlife: audit-history specification

Status: design only. Do not implement the database changes until the GitHub integration (owned by a
teammate) has landed, because discovery provenance depends on its data model and `index.ts` will have
been changed by it. Nothing here touches that integration.

## 1. Purpose

The Afterlife is the complete, tamper-evident history of a machine identity, from the moment it was
discovered to its retirement. It answers: what was found, who looked at it, what was concluded, what was
proposed, who approved or refused, what was done, what was verified, and what is true now.

## 2. Principles

1. Append-only. History rows are never updated or deleted. A correction is a new row that references the old one.
2. Real versus simulated is a first-class, mandatory field. A simulated action is never presented or counted as
   a completed remediation, in storage, API or UI.
3. Every row names its source of truth (`source`) and whether the actor was authenticated.
4. Facts and judgments are separate: observed data, AI findings (with `basis`), and human decisions are
   distinct event classes.
5. The record preserves what the user saw when they decided (the preview hash and the finding ids), so a
   decision can be reconstructed later.
6. No secret values. Only metadata, masked previews and references.

## 3. What is recorded (the lifecycle)

| # | Stage | Event types (new ones marked +) | Recorded content |
|---|---|---|---|
| 1 | Original discovery | `identity-discovered`+ | provider/source (for example `seed`, `github`), source reference, first-seen time, raw metadata snapshot hash, discovering component |
| 2 | Investigation | `investigation-started`, `finding-discovered`, `investigation-completed`, `investigation-failed` | provider (`mock` or `nemotron`), model, findings with `basis` and cited evidence, deterministic risk and factors, tool trace summary |
| 3 | Dependencies | `dependency-identified`+ | dependency name, kind, relationship, which tool call or source established it, `basis` |
| 4 | Containment | `containment-step-recorded`+ | step, whether proposed, simulated or real, actor; this release only ever `proposed` or `simulated` |
| 5 | Remediation proposals | `remediation-proposed`, `remediation-superseded`+ | plan id, action, justification, steps, investigation link |
| 6 | Human decisions | `remediation-queued`+, `remediation-revision-requested`+, `remediation-rejected`, `remediation-execution-approved`+ | decider, decision, note, preview hash approved |
| 7 | Execution | `remediation-execution-started`+, `remediation-executed`+, `remediation-failed`+ | run id, attempt, `executionMode`, per-step results |
| 8 | Verification | `remediation-verified`+, `remediation-verification-failed`+ | checks performed, observed vs expected, coverage gaps |
| 9 | Retirement status | `retirement-status-changed`+ | one of the states in section 5, with the evidence event ids that justify it |

The existing `remediation-simulated` and `identity-retired` actions are kept readable. New writes never
emit `identity-retired` for a simulated run; `identity-retired` is reserved for a verified real retirement
and is unreachable while execution is disabled.

## 4. Data model changes (to implement later)

Keep `audit_event` as the append-only spine and extend it; keep `security_event` as the live feed.

`audit_event` new columns (all with `.default(...)` so the in-place update works):

| Column | Type | Default | Purpose |
|---|---|---|---|
| `class` | string | `'legacy'` | `observation`, `ai-finding`, `human-decision`, `system-action`, `verification` |
| `executionMode` | string | `'n/a'` | `simulated`, `real`, or `n/a`; required on stages 4, 7 and 8 |
| `actorKind` | string | `'unverified'` | `human-authenticated`, `human-unverified`, `agent`, `system`; honest about today's client-supplied actors |
| `source` | string | `'app'` | origin of the fact: `seed`, `github`, `nemotron`, `mock`, `operator`, `verification-agent` |
| `refId` | option string | none | the related run, preview, finding or plan id |
| `supersedes` | option string | none | the earlier event this one corrects |
| `prevHash` | string | `''` | hash of the previous row for the same identity |
| `hash` | string | `''` | SHA-256 over this row's canonical fields plus `prevHash` |

Hash chain: the Worker computes `hash` and `prevHash` per identity chain and the reducer verifies that
`prevHash` equals the current head, so a missing or reordered row is detectable by `verify_chain` (a
read-only check run by the Verification Agent or an owner script). It is tamper-evident, not tamper-proof;
the owner can still edit data with SQL, which is why owner access must stay restricted.

New private table `identity_history_head` (`identityId` pk, `lastEventId`, `lastHash`, `count`) for the
chain head and constant-time append checks.

New private table `retirement_state` (`identityId` pk, `state`, `since`, `evidenceEventIds`, `executionMode`,
`updatedBy`). It is derived from events, written only by the reducers that write the events, and never
edited directly.

New private table `identity_discovery` (`id`, `identityId`, `source`, `sourceRef`, `firstSeenAt`,
`snapshotHash`, `discoveredBy`). Defined after the GitHub integration so `source` and `sourceRef`
match what it provides.

All new tables get `requireWorker` on their writers and a gated `v_*` view for reads, following the
existing pattern; extend `spacetime/scripts/verify-access.ts` with them.

Migration of existing data: existing `audit_event` rows take the defaults (`class='legacy'`, `hash=''`).
They are not rewritten. The chain starts at the first new row; legacy rows are displayed as "before
hash chain". The existing action values keep their meaning.

## 5. Retirement status

Derived per identity, never set freely:

| State | Meaning |
|---|---|
| `active` | no remediation decided |
| `under-investigation` | an investigation is running |
| `retirement-proposed` | a plan exists and is awaiting a decision |
| `retirement-approved` | queued or execution-approved |
| `retirement-simulated` | a simulated run completed (clearly not retired) |
| `retirement-executed` | a real run completed (unreachable in this release) |
| `retired-verified` | a real run was independently verified (unreachable in this release) |
| `retirement-failed` | last attempt failed |

Only `retired-verified` may be shown as "Retired". `retirement-simulated` is always labelled "Simulated only".

## 6. API requirements

| Route | Purpose |
|---|---|
| `GET /api/identities/:id/history` | full ordered timeline for one identity with `class`, `executionMode`, `actorKind` |
| `GET /api/audit-events?identityId=&class=&executionMode=&after=` | filtered list (existing route extended) |
| `GET /api/identities/:id/retirement-status` | derived state plus the evidence events |
| `GET /api/identities/:id/history/verify` | chain check result (read-only) |
| `GET /api/audit-events/export?identityId=` | JSON export with hashes for external review |

No route modifies history. Nothing deletes. Limits and pagination on every list route.

## 7. Presentation requirements

- Grouped by lifecycle stage; each row shows time, actor with `actorKind`, class and source.
- A persistent "Simulation" or "Real" tag on every stage 4, 7 and 8 row; simulated rows never use a success
  colour or the word "completed" without "simulated".
- Filters by stage, class and execution mode; permalink to a single event.
- AI findings show their `basis` (`confirmed`, `inferred`, `unknown`) and the evidence they cited.
- Superseded or corrected events stay visible, linked to their replacement.
- Accessible: not colour-only, keyboard navigable, announced status changes.

## 8. Security requirements

- Reads only through gated views by the service identity; the browser never talks to the database.
- Append-only enforced in reducers: there is no update or delete reducer for history tables.
- `details` are redacted of secrets before storage; an automated check rejects strings matching credential patterns.
- The export route strips nothing it should not expose and requires the same auth as other reads.
- Until user authentication exists, `actorKind` is `human-unverified` for operator actions and must be shown that way.

## 9. Test cases

1. Every lifecycle stage emits its event with the right `class`, `executionMode` and `source`.
2. A simulated run produces `executionMode='simulated'` rows and `retirement-simulated`; `identity-retired`
   is never emitted and the identity's `status` is unchanged.
3. No history table has an update or delete reducer (static check) and direct SQL DML is rejected for the
   service token (`verify-access.ts`).
4. Chain: appending with a wrong `prevHash` is rejected; deleting or reordering a row is flagged by `verify`.
5. Concurrent appends for one identity serialize; the chain stays linear.
6. A correction creates a new row with `supersedes`; the original remains.
7. Legacy rows display and are excluded from chain verification.
8. Secret-pattern redaction rejects a string like a live key in `details`.
9. Anonymous and unregistered callers get empty views and 530 on writers.
10. The retirement status is derivable from events alone: rebuilding it from history equals the stored row.
11. UI: simulated entries are visually and textually distinct; filters work; keyboard and screen-reader pass.
12. Export reproduces the same hashes as `verify`.

## 10. Sequencing

1. Wait for the GitHub integration to merge, then rebase the hardening branch.
2. Add the new `audit_event` columns, `identity_history_head`, `retirement_state` and `identity_discovery`
   in one additive publish (defaults only, no `--delete-data`).
3. Extend the Worker's `appendAudit` path to compute the hash chain.
4. Backfill nothing; label legacy rows.
5. Ship the history routes, then the UI.
