// SpacetimeDB 2.x server module (TypeScript) for Credential Reaper.
//
// This defines the persistent tables and reducers that back the machine
// identity inventory, investigations, remediation plans, and audit trail.
// The Cloudflare Worker (workers/api) reads it over SpacetimeDB's HTTP API and
// writes only through the reducers below.
//
// Timestamps are stored as ISO 8601 strings (not SpacetimeDB's native
// `Timestamp` type) so row shapes match packages/shared exactly and can be
// passed straight through the Worker API without conversion.
//
// Run with the SpacetimeDB CLI (not included in this repo):
//   spacetime dev --project-path spacetime/module
import { schema, table, t } from 'spacetimedb/server';

const finding = t.object('Finding', {
  id: t.string(),
  category: t.string(),
  severity: t.string(),
  description: t.string(),
  evidence: t.string(),
});

const toolTraceEntry = t.object('ToolTraceEntry', {
  seq: t.u32(),
  tool: t.string(),
  status: t.string(),
  summary: t.string(),
  durationMs: t.u32(),
});

const remediationStep = t.object('RemediationStep', {
  id: t.string(),
  order: t.u32(),
  description: t.string(),
  automatable: t.bool(),
});

const spacetimedb = schema({
  machineIdentity: table(
    { public: true },
    {
      id: t.string().primaryKey(),
      name: t.string(),
      type: t.string(),
      owner: t.string(),
      team: t.string(),
      environment: t.string(),
      status: t.string(),
      riskLevel: t.string(),
      riskScore: t.u32(),
      createdAt: t.string(),
      lastUsedAt: t.option(t.string()),
      tags: t.array(t.string()),
      description: t.string(),
    }
  ),

  permissionGrant: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      resource: t.string(),
      scope: t.string(),
      grantedAt: t.string(),
      grantedBy: t.string(),
    }
  ),

  identityDependency: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      name: t.string(),
      kind: t.string(),
      relationship: t.string(),
    }
  ),

  credentialMetadata: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      kind: t.string(),
      storageLocation: t.string(),
      maskedPreview: t.string(),
      createdAt: t.string(),
      lastRotatedAt: t.option(t.string()),
      expiresAt: t.option(t.string()),
    }
  ),

  usageEvent: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      timestamp: t.string(),
      action: t.string(),
      source: t.string(),
      result: t.string(),
    }
  ),

  investigation: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      identityName: t.string(),
      status: t.string(),
      startedAt: t.string(),
      completedAt: t.option(t.string()),
      requestedBy: t.string(),
      findings: t.array(finding),
      aiSummary: t.option(t.string()),
      recommendedAction: t.option(t.string()),
      source: t.string(),
      // Columns below were added after the first publish. They carry defaults so
      // SpacetimeDB can auto-migrate existing rows. `findingBases[i]` is the
      // basis ("confirmed" | "inferred" | "unknown") of `findings[i]`: the
      // nested Finding type can't gain a field without a breaking migration.
      riskScore: t.u32().default(0),
      riskLevel: t.string().default(''),
      riskFactors: t.array(t.string()).default([]),
      findingBases: t.array(t.string()).default([]),
      toolTrace: t.array(toolTraceEntry).default([]),
    }
  ),

  remediationPlan: table(
    { public: true, indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identityId'] }] },
    {
      id: t.string().primaryKey(),
      identityId: t.string(),
      identityName: t.string(),
      investigationId: t.option(t.string()),
      action: t.string(),
      justification: t.string(),
      steps: t.array(remediationStep),
      status: t.string(),
      createdAt: t.string(),
      simulatedAt: t.option(t.string()),
    }
  ),

  auditEvent: table(
    { public: true, indexes: [{ accessor: 'byTimestamp', algorithm: 'btree', columns: ['timestamp'] }] },
    {
      id: t.string().primaryKey(),
      timestamp: t.string(),
      action: t.string(),
      actor: t.string(),
      identityId: t.option(t.string()),
      identityName: t.option(t.string()),
      investigationId: t.option(t.string()),
      remediationId: t.option(t.string()),
      details: t.string(),
    }
  ),
});

export default spacetimedb;

// Seed reducers: the only way to write rows into the five "static inventory"
// tables, since nothing in the app creates/edits machine identities today.
// The Worker calls these once (if the tables are empty) to bootstrap data
// that previously lived in workers/api/src/data.ts.

export const seedIdentity = spacetimedb.reducer(
  {
    id: t.string(),
    name: t.string(),
    type: t.string(),
    owner: t.string(),
    team: t.string(),
    environment: t.string(),
    status: t.string(),
    riskLevel: t.string(),
    riskScore: t.u32(),
    createdAt: t.string(),
    lastUsedAt: t.option(t.string()),
    tags: t.array(t.string()),
    description: t.string(),
  },
  (ctx, fields) => {
    ctx.db.machineIdentity.insert({ ...fields, lastUsedAt: fields.lastUsedAt ?? undefined });
  }
);

export const seedPermission = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    resource: t.string(),
    scope: t.string(),
    grantedAt: t.string(),
    grantedBy: t.string(),
  },
  (ctx, fields) => {
    ctx.db.permissionGrant.insert(fields);
  }
);

export const seedDependency = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    name: t.string(),
    kind: t.string(),
    relationship: t.string(),
  },
  (ctx, fields) => {
    ctx.db.identityDependency.insert(fields);
  }
);

export const seedCredential = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    kind: t.string(),
    storageLocation: t.string(),
    maskedPreview: t.string(),
    createdAt: t.string(),
    lastRotatedAt: t.option(t.string()),
    expiresAt: t.option(t.string()),
  },
  (ctx, fields) => {
    ctx.db.credentialMetadata.insert({
      ...fields,
      lastRotatedAt: fields.lastRotatedAt ?? undefined,
      expiresAt: fields.expiresAt ?? undefined,
    });
  }
);

export const seedUsageEvent = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    timestamp: t.string(),
    action: t.string(),
    source: t.string(),
    result: t.string(),
  },
  (ctx, fields) => {
    ctx.db.usageEvent.insert(fields);
  }
);

/** Creates an investigation row in "running" status. The caller (Worker) supplies the id. */
export const startInvestigation = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    identityName: t.string(),
    requestedBy: t.string(),
    startedAt: t.string(),
    source: t.string(),
  },
  (ctx, { id, identityId, identityName, requestedBy, startedAt, source }) => {
    ctx.db.investigation.insert({
      id,
      identityId,
      identityName,
      status: 'running',
      startedAt,
      completedAt: undefined,
      requestedBy,
      findings: [],
      aiSummary: undefined,
      recommendedAction: undefined,
      source,
      riskScore: 0,
      riskLevel: '',
      riskFactors: [],
      findingBases: [],
      toolTrace: [],
    });
    ctx.db.auditEvent.insert({
      id: `${id}-started`,
      timestamp: startedAt,
      action: 'investigation-started',
      actor: requestedBy,
      identityId,
      identityName,
      investigationId: id,
      remediationId: undefined,
      details: `Investigation started for ${identityName}.`,
    });
  }
);

/** Appends one finding to a running investigation. Called as the agent records each finding. */
export const recordFinding = spacetimedb.reducer(
  {
    investigationId: t.string(),
    id: t.string(),
    category: t.string(),
    severity: t.string(),
    basis: t.string(),
    description: t.string(),
    evidence: t.string(),
  },
  (ctx, { investigationId, id, category, severity, basis, description, evidence }) => {
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing || existing.status !== 'running') return;

    ctx.db.investigation.id.update({
      ...existing,
      findings: [...existing.findings, { id, category, severity, description, evidence }],
      findingBases: [...existing.findingBases, basis],
    });
  }
);

/** Finalizes a running investigation. Findings were already appended via recordFinding. */
export const completeInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    completedAt: t.string(),
    aiSummary: t.string(),
    recommendedAction: t.string(),
    riskScore: t.u32(),
    riskLevel: t.string(),
    riskFactors: t.array(t.string()),
    toolTrace: t.array(toolTraceEntry),
    actor: t.string(),
  },
  (ctx, { investigationId, completedAt, aiSummary, recommendedAction, riskScore, riskLevel, riskFactors, toolTrace, actor }) => {
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing) return;

    ctx.db.investigation.id.update({
      ...existing,
      status: 'completed',
      completedAt,
      aiSummary,
      recommendedAction,
      riskScore,
      riskLevel,
      riskFactors,
      toolTrace,
    });
    ctx.db.auditEvent.insert({
      id: `${investigationId}-completed`,
      timestamp: completedAt,
      action: 'investigation-completed',
      actor,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      remediationId: undefined,
      details: `Investigation completed with ${existing.findings.length} finding(s), risk ${riskScore} (${riskLevel}): recommend ${recommendedAction}.`,
    });
  }
);

/** Marks a running investigation as failed. Keeps any findings recorded before the failure. */
export const failInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    completedAt: t.string(),
    reason: t.string(),
    toolTrace: t.array(toolTraceEntry),
    actor: t.string(),
  },
  (ctx, { investigationId, completedAt, reason, toolTrace, actor }) => {
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing) return;

    ctx.db.investigation.id.update({ ...existing, status: 'failed', completedAt, aiSummary: reason, toolTrace });
    ctx.db.auditEvent.insert({
      id: `${investigationId}-failed`,
      timestamp: completedAt,
      action: 'investigation-failed',
      actor,
      identityId: existing.identityId,
      identityName: existing.identityName,
      investigationId,
      remediationId: undefined,
      details: `Investigation failed: ${reason}`,
    });
  }
);

/** Proposes a retirement/rotation/migration plan, usually following an investigation. */
export const proposeRemediation = spacetimedb.reducer(
  {
    id: t.string(),
    identityId: t.string(),
    identityName: t.string(),
    investigationId: t.option(t.string()),
    action: t.string(),
    justification: t.string(),
    steps: t.array(remediationStep),
    createdAt: t.string(),
    actor: t.string(),
  },
  (ctx, { id, identityId, identityName, investigationId, action, justification, steps, createdAt, actor }) => {
    ctx.db.remediationPlan.insert({
      id,
      identityId,
      identityName,
      investigationId,
      action,
      justification,
      steps,
      status: 'proposed',
      createdAt,
      simulatedAt: undefined,
    });
    ctx.db.auditEvent.insert({
      id: `${id}-proposed`,
      timestamp: createdAt,
      action: 'remediation-proposed',
      actor,
      identityId,
      identityName,
      investigationId,
      remediationId: id,
      details: `${action} plan proposed for ${identityName}.`,
    });
  }
);

/** Marks a remediation plan as simulated. This never touches a real credential. */
export const simulateRemediation = spacetimedb.reducer(
  { planId: t.string(), simulatedAt: t.string(), actor: t.string() },
  (ctx, { planId, simulatedAt, actor }) => {
    const plan = ctx.db.remediationPlan.id.find(planId);
    if (!plan) return;

    ctx.db.remediationPlan.id.update({ ...plan, status: 'simulated', simulatedAt });
    ctx.db.auditEvent.insert({
      id: `${planId}-simulated-${simulatedAt}`,
      timestamp: simulatedAt,
      action: 'remediation-simulated',
      actor,
      identityId: plan.identityId,
      identityName: plan.identityName,
      investigationId: plan.investigationId,
      remediationId: planId,
      details: `Dry-run simulation completed for "${plan.action}" plan. No live credential was touched.`,
    });
  }
);
