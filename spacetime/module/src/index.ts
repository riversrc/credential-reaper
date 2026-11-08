// SpacetimeDB 2.x server module (TypeScript) for Credential Reaper.
//
// This defines the persistent tables and reducers that back the machine
// identity inventory, investigations, remediation plans, and audit trail.
// It is not yet wired up to the Cloudflare Worker (workers/api), which
// currently serves the same shapes from in-memory seed data — swapping the
// Worker over to call into a published instance of this module is the next
// integration step.
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

/** Records the AI provider's result against a previously-started investigation. */
export const completeInvestigation = spacetimedb.reducer(
  {
    investigationId: t.string(),
    completedAt: t.string(),
    findings: t.array(finding),
    aiSummary: t.string(),
    recommendedAction: t.string(),
    actor: t.string(),
  },
  (ctx, { investigationId, completedAt, findings, aiSummary, recommendedAction, actor }) => {
    const existing = ctx.db.investigation.id.find(investigationId);
    if (!existing) return;

    ctx.db.investigation.id.update({
      ...existing,
      status: 'completed',
      completedAt,
      findings,
      aiSummary,
      recommendedAction,
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
      details: `Investigation completed: recommend ${recommendedAction}.`,
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
