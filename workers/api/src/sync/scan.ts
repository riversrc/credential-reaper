// Offline repository scanner. Reads `inventory/manifest.yaml`, follows the source globs it declares and
// emits typed, provenance-tagged records. Repository evidence only: nothing here observes runtime
// behaviour, and no record is ever labelled as runtime evidence.
import { parse } from 'yaml';
import type {
  RepositoryScan,
  ScanConfidence,
  ScanEvidenceType,
  ScanProvenance,
  ScanWarning,
  ScanWarningCode,
  ScannedAssignment,
  ScannedCodeowner,
  ScannedEndpoint,
  ScannedExternalProvider,
  ScannedGatewayRoute,
  ScannedIdentity,
  ScannedIdentityBinding,
  ScannedIdentityOwnership,
  ScannedPerson,
  ScannedPermission,
  ScannedPermissionHistory,
  ScannedProviderDependency,
  ScannedService,
  ScannedServiceDependency,
  ScannedServiceOwnership,
  ScannedTeam,
} from '@credential-reaper/shared';
import { globPaths } from './source.ts';
import type { RepoSource } from './source.ts';

export const MANIFEST_PATH = 'inventory/manifest.yaml';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export interface ScanContext {
  repo: string;
  commitSha: string | null;
  /** Injectable for tests; defaults to now. */
  now?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objList = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** `/v1/x/{id}` and `/v1/x/:id` are the same route. */
const normalizePath = (p: string): string => p.replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, '{}');
const toTemplate = (p: string): string => p.replace(/:([A-Za-z_]\w*)/g, '{$1}');
const serviceFromPath = (p: string): string => p.split('/')[1] ?? '';

function mergeProvenance(...groups: ScanProvenance[][]): ScanProvenance[] {
  const seen = new Set<string>();
  const out: ScanProvenance[] = [];
  for (const group of groups) {
    for (const p of group) {
      const k = `${p.sourcePath}|${p.evidenceType}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(p);
      }
    }
  }
  return out;
}

function metaField(meta: string, name: string): string | null | undefined {
  const m = meta.match(new RegExp('\\b' + name + '\\s*:\\s*(?:([\'"`])([^\'"`]*)\\1|(null))'));
  if (!m) return undefined;
  return m[3] ? null : (m[2] ?? null);
}

export function scanRepository(source: RepoSource, ctx: ScanContext): RepositoryScan {
  const scannedAt = ctx.now ?? new Date().toISOString();
  const warnings: ScanWarning[] = [];
  const warn = (code: ScanWarningCode, sourcePath: string, message: string): void => {
    warnings.push({ code, sourcePath, message });
  };
  const prov = (sourcePath: string, evidenceType: ScanEvidenceType, confidence: ScanConfidence): ScanProvenance => ({
    repo: ctx.repo,
    sourcePath,
    commitSha: ctx.commitSha,
    discoveredAt: scannedAt,
    evidenceType,
    confidence,
  });
  const declared = (p: string): ScanProvenance => prov(p, 'repository-declaration', 'high');
  const referenced = (p: string): ScanProvenance => prov(p, 'source-reference', 'medium');

  const text = (p: string): string | null => {
    try {
      return source.read(p);
    } catch {
      warn('missing-source', p, 'File could not be read.');
      return null;
    }
  };
  const yamlDoc = (p: string): Obj | null => {
    const t = text(p);
    if (t === null) return null;
    try {
      const v: unknown = parse(t);
      if (!isObj(v)) {
        warn('parse-error', p, 'Expected a YAML mapping at the top level.');
        return null;
      }
      return v;
    } catch (e) {
      warn('parse-error', p, `YAML could not be parsed: ${e instanceof Error ? e.message.split('\n')[0]!.slice(0, 160) : 'unknown error'}`);
      return null;
    }
  };

  function bucket<T extends { key: string }>(label: string) {
    const map = new Map<string, T>();
    return {
      map,
      add(record: T, sourcePath: string): void {
        if (map.has(record.key)) warn('duplicate-key', sourcePath, `Duplicate ${label} "${record.key}"; keeping the first.`);
        else map.set(record.key, record);
      },
      values: (): T[] => [...map.values()].sort(byKey),
    };
  }

  // ---- manifest
  if (!source.paths.includes(MANIFEST_PATH)) throw new Error(`${MANIFEST_PATH} not found; this is not an inventory-manifest repository.`);
  const manifest = yamlDoc(MANIFEST_PATH);
  if (!manifest || manifest.schemaVersion !== 1) throw new Error(`${MANIFEST_PATH} is unreadable or has an unsupported schemaVersion.`);
  const manifestSources = obj(manifest.sources);
  const files = (group: string, name?: string): string[] => {
    const pattern = name ? str(obj(manifestSources[group])[name]) : str(manifestSources[group]);
    if (!pattern) {
      warn('missing-source', MANIFEST_PATH, `Manifest declares no sources.${group}${name ? '.' + name : ''}.`);
      return [];
    }
    const matches = globPaths(source.paths, pattern);
    if (matches.length === 0) warn('missing-source', MANIFEST_PATH, `Manifest pattern "${pattern}" matched no files.`);
    return matches;
  };

  // ---- services
  const services = bucket<ScannedService>('service');
  for (const p of files('services', 'definitions')) {
    const y = yamlDoc(p);
    if (!y) continue;
    const id = str(y.id);
    if (!id) {
      warn('parse-error', p, 'Service has no id.');
      continue;
    }
    if (serviceFromPath(p) !== id) warn('cross-source-mismatch', p, `Service id "${id}" does not match its directory "${serviceFromPath(p)}".`);
    services.add(
      {
        key: id,
        id,
        name: str(y.name) ?? id,
        description: str(y.description),
        lifecycle: str(y.lifecycle),
        tier: str(y.tier),
        dataClassification: str(y.dataClassification),
        owningTeamId: str(y.owningTeam),
        port: typeof obj(y.runtime).port === 'number' ? (obj(y.runtime).port as number) : null,
        basePath: str(obj(y.api).basePath),
        provenance: [declared(p)],
      },
      p
    );
  }

  // ---- outbound clients: variable name -> target, so call sites can be attributed to an edge
  const clientTargets = new Map<string, string>(); // `${service}|${kind}|${var}` -> target id
  const declaredClientEdges = new Set<string>(); // `${kind}|${from}->${target}`
  const clientsPathByService = new Map<string, string>();
  for (const p of files('services', 'outboundClients')) {
    const t = text(p);
    if (t === null) continue;
    const serviceId = serviceFromPath(p);
    clientsPathByService.set(serviceId, p);
    for (const m of t.matchAll(/(\w+)\s*:\s*create(Service|External)Client\(\s*['"]([\w-]+)['"]\s*\)/g)) {
      const kind = m[2] === 'Service' ? 'service' : 'provider';
      clientTargets.set(`${serviceId}|${kind}|${m[1]}`, m[3]!);
      declaredClientEdges.add(`${kind}|${serviceId}->${m[3]}`);
    }
  }

  // ---- endpoints: OpenAPI is the declaration, the route source is a corroborating source reference
  const endpoints = bucket<ScannedEndpoint>('endpoint');
  const endpointByRoute = new Map<string, ScannedEndpoint>();
  for (const p of files('services', 'openapi')) {
    const doc = yamlDoc(p);
    if (!doc) continue;
    const serviceId = str(obj(doc.info)['x-arasaka-service']) ?? serviceFromPath(p);
    for (const [path, item] of Object.entries(obj(doc.paths))) {
      if (!isObj(item)) continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        const security = op.security ?? doc.security;
        const record: ScannedEndpoint = {
          key: `${serviceId}:${method.toUpperCase()} ${path}`,
          serviceId,
          method: method.toUpperCase(),
          path,
          operationId: str(op.operationId),
          permissionId: str(op['x-arasaka-permission']),
          identityId: str(op['x-arasaka-identity']),
          authenticated: Array.isArray(security) && security.length > 0,
          authMode: null,
          deprecated: op.deprecated === true,
          declaredInOpenApi: true,
          declaredInRouteSource: false,
          provenance: [declared(p)],
        };
        const routeKey = `${serviceId}|${record.method}|${normalizePath(path)}`;
        if (endpointByRoute.has(routeKey)) {
          warn('duplicate-key', p, `Duplicate endpoint ${record.method} ${path} in ${serviceId}.`);
          continue;
        }
        endpointByRoute.set(routeKey, record);
        endpoints.add(record, p);
      }
    }
  }

  const callSiteCounts = new Map<string, number>(); // `${kind}|${from}->${target}`
  const identityReferences = new Map<string, ScanProvenance[]>(); // identity id -> source references
  const addIdentityReference = (id: string, p: string): void => {
    identityReferences.set(id, mergeProvenance(identityReferences.get(id) ?? [], [referenced(p)]));
  };
  const routesPathByService = new Map<string, string>();
  for (const p of files('services', 'routeSources')) {
    const t = text(p);
    if (t === null) continue;
    const serviceId = serviceFromPath(p);
    routesPathByService.set(serviceId, p);
    for (const m of t.matchAll(/router\.(get|post|put|patch|delete|head|options)\(\s*(['"`])([^'"`]+)\2\s*,\s*\{([^}]*)\}/g)) {
      const method = m[1]!.toUpperCase();
      const path = m[3]!;
      const meta = m[4]!;
      const operationId = metaField(meta, 'operationId') ?? null;
      const permissionId = metaField(meta, 'permission') ?? null;
      const identityId = metaField(meta, 'identity') ?? null;
      const authMode = metaField(meta, 'auth') ?? null;
      if (identityId) addIdentityReference(identityId, p);
      const routeKey = `${serviceId}|${method}|${normalizePath(path)}`;
      const existing = endpointByRoute.get(routeKey);
      if (!existing) {
        warn('cross-source-mismatch', p, `Route ${method} ${path} in ${serviceId} is not declared in its OpenAPI file.`);
        const record: ScannedEndpoint = {
          key: `${serviceId}:${method} ${toTemplate(path)}`,
          serviceId,
          method,
          path: toTemplate(path),
          operationId,
          permissionId,
          identityId,
          authenticated: authMode !== null && authMode !== 'none',
          authMode,
          deprecated: false,
          declaredInOpenApi: false,
          declaredInRouteSource: true,
          provenance: [referenced(p)],
        };
        endpointByRoute.set(routeKey, record);
        endpoints.add(record, p);
        continue;
      }
      existing.declaredInRouteSource = true;
      existing.authMode = authMode;
      existing.provenance = mergeProvenance(existing.provenance, [referenced(p)]);
      const compare: Array<[string, string | null, string | null]> = [
        ['operationId', existing.operationId, operationId],
        ['permission', existing.permissionId, permissionId],
        ['identity', existing.identityId, identityId],
      ];
      for (const [field, fromSpec, fromRoute] of compare) {
        if (fromSpec !== fromRoute) warn('cross-source-mismatch', p, `${method} ${path} in ${serviceId}: ${field} is "${fromSpec}" in OpenAPI but "${fromRoute}" in the route source.`);
      }
      if (existing.authenticated !== (authMode !== null && authMode !== 'none')) {
        warn('cross-source-mismatch', p, `${method} ${path} in ${serviceId}: OpenAPI authentication (${existing.authenticated}) disagrees with route auth "${authMode}".`);
      }
    }
    for (const m of t.matchAll(/\b(clients|providers)\.(\w+)\.call\(\s*['"](MI-\d+)['"]/g)) {
      const kind = m[1] === 'clients' ? 'service' : 'provider';
      const target = clientTargets.get(`${serviceId}|${kind}|${m[2]}`);
      addIdentityReference(m[3]!, p);
      if (!target) {
        warn('cross-source-mismatch', p, `Call site uses ${m[1]}.${m[2]}, which has no client declaration in ${serviceId}.`);
        continue;
      }
      const edgeKey = `${kind}|${serviceId}->${target}`;
      callSiteCounts.set(edgeKey, (callSiteCounts.get(edgeKey) ?? 0) + 1);
    }
  }

  // ---- identity bindings (source) and service configuration (declaration)
  const sourceBindingModes = new Map<string, string | null>(); // `${service}|${identity}`
  const identityBindingsPath = new Map<string, string>(); // `${service}|${identity}` -> path
  for (const p of files('services', 'identityBindings')) {
    const t = text(p);
    if (t === null) continue;
    const serviceId = serviceFromPath(p);
    for (const m of t.matchAll(/\{\s*id:\s*(['"])(MI-\d+)\1([^}]*)\}/g)) {
      sourceBindingModes.set(`${serviceId}|${m[2]}`, m[3]!.match(/\bmode:\s*(['"])([\w-]+)\1/)?.[2] ?? null);
      identityBindingsPath.set(`${serviceId}|${m[2]}`, p);
    }
  }

  const bindingEntries = new Map<string, Array<{ binding: ScannedIdentityBinding; path: string }>>();
  const serviceDependencies = bucket<ScannedServiceDependency>('service dependency');
  const providerDependencies = bucket<ScannedProviderDependency>('provider dependency');
  const configuredBindingKeys = new Set<string>();
  for (const p of files('services', 'serviceReferences')) {
    const y = yamlDoc(p);
    if (!y) continue;
    const serviceId = str(y.service) ?? serviceFromPath(p);
    for (const b of objList(y.machineIdentities)) {
      const ref = str(b.ref);
      if (!ref) continue;
      const bindingKey = `${serviceId}|${ref}`;
      configuredBindingKeys.add(bindingKey);
      const mode = str(b.mode);
      const inSource = sourceBindingModes.has(bindingKey);
      if (inSource && sourceBindingModes.get(bindingKey) !== mode) {
        warn('cross-source-mismatch', p, `${ref} in ${serviceId}: mode is "${mode}" in configuration but "${sourceBindingModes.get(bindingKey)}" in identities.ts.`);
      }
      const list = bindingEntries.get(ref) ?? [];
      list.push({ binding: { serviceId, usage: str(b.usage), mode, declaredInIdentityBindingsSource: inSource }, path: p });
      bindingEntries.set(ref, list);
    }
    const dependencies = obj(y.dependencies);
    for (const d of objList(dependencies.internalServices)) {
      const to = str(d.service);
      if (!to) continue;
      const edge = `service|${serviceId}->${to}`;
      const callSiteCount = callSiteCounts.get(edge) ?? 0;
      const clientDeclared = declaredClientEdges.has(edge);
      serviceDependencies.add(
        {
          key: `${serviceId}->${to}`,
          fromServiceId: serviceId,
          toServiceId: to,
          baseUrlEnv: str(d.baseUrlEnv),
          callsAs: strList(d.callsAs).sort(),
          clientDeclaredInSource: clientDeclared,
          callSiteCount,
          provenance: mergeProvenance(
            [declared(p)],
            clientDeclared && clientsPathByService.has(serviceId) ? [referenced(clientsPathByService.get(serviceId)!)] : [],
            callSiteCount > 0 && routesPathByService.has(serviceId) ? [referenced(routesPathByService.get(serviceId)!)] : []
          ),
        },
        p
      );
    }
    for (const d of objList(dependencies.externalProviders)) {
      const providerId = str(d.provider);
      if (!providerId) continue;
      const edge = `provider|${serviceId}->${providerId}`;
      const callSiteCount = callSiteCounts.get(edge) ?? 0;
      const clientDeclared = declaredClientEdges.has(edge);
      const declaredEvidence = str(d.evidence);
      if (declaredEvidence === 'source-and-configuration' && callSiteCount === 0) {
        warn('cross-source-mismatch', p, `${serviceId} -> ${providerId} is labelled source-and-configuration but no call site was found.`);
      }
      if (declaredEvidence === 'configuration-only' && callSiteCount > 0) {
        warn('cross-source-mismatch', p, `${serviceId} -> ${providerId} is labelled configuration-only but ${callSiteCount} call site(s) were found.`);
      }
      providerDependencies.add(
        {
          key: `${serviceId}->${providerId}`,
          serviceId,
          providerId,
          baseUrlEnv: str(d.baseUrlEnv),
          callsAs: strList(d.callsAs).sort(),
          declaredEvidence,
          clientDeclaredInSource: clientDeclared,
          callSiteCount,
          provenance: mergeProvenance(
            [declared(p)],
            clientDeclared && clientsPathByService.has(serviceId) ? [referenced(clientsPathByService.get(serviceId)!)] : [],
            callSiteCount > 0 && routesPathByService.has(serviceId) ? [referenced(routesPathByService.get(serviceId)!)] : []
          ),
        },
        p
      );
    }
  }
  for (const bindingKey of sourceBindingModes.keys()) {
    if (!configuredBindingKeys.has(bindingKey)) {
      const [serviceId, id] = bindingKey.split('|');
      warn('cross-source-mismatch', identityBindingsPath.get(bindingKey) ?? MANIFEST_PATH, `${id} is bound in ${serviceId}'s identities.ts but not in its service configuration.`);
    }
  }
  for (const edge of callSiteCounts.keys()) {
    const [kind, pair] = edge.split('|') as [string, string];
    const known = kind === 'service' ? serviceDependencies.map.has(pair) : providerDependencies.map.has(pair);
    if (!known) warn('cross-source-mismatch', MANIFEST_PATH, `Call sites reach ${pair} but the service configuration does not declare that dependency.`);
  }

  // ---- machine identities
  const identities = bucket<ScannedIdentity>('machine identity');
  const endpointList = endpoints.values();
  for (const p of files('machineIdentities', 'declarations')) {
    const y = yamlDoc(p);
    if (!y) continue;
    const id = str(y.id);
    const type = str(y.type);
    if (!id || !type) {
      warn('parse-error', p, 'Identity is missing id or type.');
      continue;
    }
    const credential = obj(y.credential);
    const flaggedReal = credential.containsRealSecret !== false;
    if (flaggedReal) warn('secret-flag', p, `${id}: credential.containsRealSecret is not false; credential fields were dropped.`);
    const lifecycle = obj(y.lifecycle);
    const entries = (bindingEntries.get(id) ?? []).sort((a, b) => (a.binding.serviceId < b.binding.serviceId ? -1 : 1));
    const acting = endpointList.filter((e) => e.identityId === id);
    identities.add(
      {
        key: id,
        id,
        name: str(y.name) ?? id,
        type,
        purpose: str(y.purpose),
        environment: str(y.environment),
        declaredStatus: str(y.status),
        owningServiceId: str(y.owningService),
        introducedOn: str(lifecycle.introducedOn),
        introducedBy: str(lifecycle.introducedBy),
        expiresOn: str(lifecycle.expiresOn),
        credential: {
          storage: str(credential.storage),
          secretRef: flaggedReal ? null : str(credential.secretRef),
          secretRefEnv: str(credential.secretRefEnv),
          maskedPreview: flaggedReal ? null : str(credential.maskedPreview),
          lastRotatedOn: str(credential.lastRotatedOn),
        },
        tags: strList(y.tags),
        homeServiceMode: str(obj(y.configuredUsage).homeServiceMode),
        bindings: entries.map((e) => e.binding),
        actsOnEndpointKeys: acting.map((e) => e.key),
        provenance: mergeProvenance(
          [declared(p)],
          entries.map((e) => declared(e.path)),
          entries.filter((e) => e.binding.declaredInIdentityBindingsSource).map((e) => referenced(identityBindingsPath.get(`${e.binding.serviceId}|${id}`)!)),
          acting.flatMap((e) => e.provenance),
          identityReferences.get(id) ?? []
        ),
      },
      p
    );
  }

  // ---- permissions and assignments
  const permissions = bucket<ScannedPermission>('permission');
  for (const p of files('permissions', 'definitions')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const d of objList(y.permissions)) {
      const id = str(d.id);
      if (!id) continue;
      permissions.add(
        { key: id, id, resource: str(d.resource), action: str(d.action), level: str(d.level), sensitivity: str(d.sensitivity), description: str(d.description), provenance: [declared(p)] },
        p
      );
    }
  }
  const assignments = bucket<ScannedAssignment>('permission assignment');
  const permissionHistory = bucket<ScannedPermissionHistory>('permission history entry');
  for (const p of files('permissions', 'assignments')) {
    const y = yamlDoc(p);
    if (!y) continue;
    const identityId = str(y.identityId);
    if (!identityId) {
      warn('parse-error', p, 'Assignment file has no identityId.');
      continue;
    }
    for (const a of objList(y.assignments)) {
      const permissionId = str(a.permission);
      if (!permissionId) continue;
      const scope = obj(a.scope);
      const environment = str(scope.environment);
      const resource = str(scope.resource);
      assignments.add(
        { key: `${identityId}|${permissionId}|${environment}|${resource}`, identityId, permissionId, environment, resource, reviewStatus: str(a.reviewStatus), grantedOn: str(a.grantedOn), provenance: [declared(p)] },
        p
      );
    }
    for (const h of objList(y.history)) {
      const record: ScannedPermissionHistory = {
        key: `${identityId}|${str(h.date)}|${str(h.change)}|${str(h.permission)}|${str(h.ticket)}`,
        identityId,
        permissionId: str(h.permission),
        date: str(h.date),
        change: str(h.change),
        ticket: str(h.ticket),
        note: str(h.note),
        provenance: [declared(p)],
      };
      permissionHistory.add(record, p);
    }
  }

  // ---- ownership
  const teams = bucket<ScannedTeam>('team');
  for (const p of files('ownership', 'teams')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const t of objList(y.teams)) {
      const id = str(t.id);
      if (!id) continue;
      teams.add(
        { key: id, id, name: str(t.name) ?? id, leadId: str(t.lead), securityContactId: str(t.securityContact), channel: str(t.channel), githubTeam: str(t.githubTeam), memberIds: strList(t.members).sort(), provenance: [declared(p)] },
        p
      );
    }
  }
  const people = bucket<ScannedPerson>('person');
  for (const p of files('ownership', 'people')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const person of objList(y.people)) {
      const id = str(person.id);
      if (!id) continue;
      people.add(
        {
          key: id,
          id,
          name: str(person.name) ?? id,
          title: str(person.title),
          teamId: str(person.team),
          status: str(person.status),
          repositoryRole: str(person.repositoryRole),
          githubHandle: str(person.githubHandle),
          joined: str(person.joined),
          left: str(person.left),
          provenance: [declared(p)],
        },
        p
      );
    }
  }
  const serviceOwnership = bucket<ScannedServiceOwnership>('service ownership');
  for (const p of files('ownership', 'serviceOwnership')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const s of objList(y.services)) {
      const serviceId = str(s.service);
      if (!serviceId) continue;
      serviceOwnership.add(
        { key: serviceId, serviceId, owningTeamId: str(s.owningTeam), maintainerIds: strList(s.maintainers).sort(), tier: str(s.tier), status: str(s.status), reviewCadence: str(s.reviewCadence), provenance: [declared(p)] },
        p
      );
    }
  }
  const identityOwnership = bucket<ScannedIdentityOwnership>('identity ownership');
  for (const p of files('ownership', 'identityOwnership')) {
    const y = yamlDoc(p);
    if (!y) continue;
    const identityId = str(y.identityId);
    if (!identityId) {
      warn('parse-error', p, 'Ownership file has no identityId.');
      continue;
    }
    identityOwnership.add(
      {
        key: identityId,
        identityId,
        owningTeamId: str(y.owningTeam),
        owningServiceId: str(y.owningService),
        primaryOwnerId: str(y.primaryOwner),
        ownershipStatus: str(y.ownershipStatus),
        ownerEmploymentStatus: str(y.ownerEmploymentStatus),
        lastReviewedOn: str(y.lastReviewedOn),
        note: str(y.note),
        provenance: [declared(p)],
      },
      p
    );
  }
  const codeowners = bucket<ScannedCodeowner>('CODEOWNERS rule');
  for (const p of files('ownership', 'codeowners')) {
    const t = text(p);
    if (t === null) continue;
    for (const line of t.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const [pattern, ...owners] = trimmed.split(/\s+/);
      codeowners.add({ key: pattern!, pattern: pattern!, owners: owners.sort(), provenance: [declared(p)] }, p);
    }
  }

  // ---- external providers and gateway routes
  const externalProviders = bucket<ScannedExternalProvider>('external provider');
  for (const p of files('externalProviders')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const d of objList(y.providers)) {
      const id = str(d.id);
      if (!id) continue;
      externalProviders.add(
        { key: id, id, name: str(d.name) ?? id, category: str(d.category), domain: str(d.fictionalDomain), baseUrlEnv: str(d.baseUrlEnv), contractEndsOn: str(d.contractEndsOn), owningTeamId: str(d.owningTeam), provenance: [declared(p)] },
        p
      );
    }
  }
  const gatewayRoutes = bucket<ScannedGatewayRoute>('gateway route');
  for (const p of files('services', 'gatewayRoutes')) {
    const y = yamlDoc(p);
    if (!y) continue;
    for (const r of objList(y.routes)) {
      const pathPrefix = str(r.pathPrefix);
      if (!pathPrefix) continue;
      gatewayRoutes.add(
        { key: pathPrefix, pathPrefix, upstreamServiceId: str(r.upstream), authMode: str(r.authMode), forwardAsIdentityId: str(r.forwardAs), provenance: [declared(p)] },
        p
      );
    }
  }

  // ---- dangling references
  const ids = {
    service: new Set(services.map.keys()),
    identity: new Set(identities.map.keys()),
    permission: new Set(permissions.map.keys()),
    team: new Set(teams.map.keys()),
    person: new Set(people.map.keys()),
    provider: new Set(externalProviders.map.keys()),
  };
  const check = (kind: keyof typeof ids, id: string | null, p: string, where: string): void => {
    if (id !== null && !ids[kind].has(id)) warn('unknown-reference', p, `${where} references unknown ${kind} "${id}".`);
  };
  const first = (r: { provenance: ScanProvenance[] }): string => r.provenance[0]!.sourcePath;
  for (const i of identities.values()) {
    check('service', i.owningServiceId, first(i), i.id);
    for (const b of i.bindings) check('service', b.serviceId, first(i), `${i.id} binding`);
  }
  for (const e of endpoints.values()) {
    check('service', e.serviceId, first(e), e.key);
    check('identity', e.identityId, first(e), e.key);
    check('permission', e.permissionId, first(e), e.key);
  }
  for (const a of assignments.values()) {
    check('identity', a.identityId, first(a), 'assignment');
    check('permission', a.permissionId, first(a), `assignment of ${a.identityId}`);
  }
  for (const o of identityOwnership.values()) {
    check('identity', o.identityId, first(o), 'ownership record');
    check('person', o.primaryOwnerId, first(o), `ownership of ${o.identityId}`);
    check('team', o.owningTeamId, first(o), `ownership of ${o.identityId}`);
  }
  for (const t of teams.values()) {
    check('person', t.leadId, first(t), `team ${t.id} lead`);
    check('person', t.securityContactId, first(t), `team ${t.id} security contact`);
    for (const m of t.memberIds) check('person', m, first(t), `team ${t.id} member`);
  }
  for (const person of people.values()) check('team', person.teamId, first(person), `person ${person.id}`);
  for (const s of services.values()) check('team', s.owningTeamId, first(s), `service ${s.id}`);
  for (const d of serviceDependencies.values()) {
    check('service', d.fromServiceId, first(d), d.key);
    check('service', d.toServiceId, first(d), d.key);
    for (const id of d.callsAs) check('identity', id, first(d), `${d.key} callsAs`);
  }
  for (const d of providerDependencies.values()) {
    check('service', d.serviceId, first(d), d.key);
    check('provider', d.providerId, first(d), d.key);
    for (const id of d.callsAs) check('identity', id, first(d), `${d.key} callsAs`);
  }
  for (const r of gatewayRoutes.values()) {
    check('service', r.upstreamServiceId, first(r), `gateway ${r.pathPrefix}`);
    check('identity', r.forwardAsIdentityId, first(r), `gateway ${r.pathPrefix}`);
  }

  const result = {
    services: services.values(),
    endpoints: endpointList,
    machineIdentities: identities.values(),
    permissions: permissions.values(),
    assignments: assignments.values(),
    permissionHistory: permissionHistory.values(),
    teams: teams.values(),
    people: people.values(),
    serviceOwnership: serviceOwnership.values(),
    identityOwnership: identityOwnership.values(),
    serviceDependencies: serviceDependencies.values(),
    providerDependencies: providerDependencies.values(),
    externalProviders: externalProviders.values(),
    gatewayRoutes: gatewayRoutes.values(),
    codeowners: codeowners.values(),
  };
  return {
    schemaVersion: 1,
    repo: ctx.repo,
    commitSha: ctx.commitSha,
    scannedAt,
    manifestPath: MANIFEST_PATH,
    status: warnings.some((w) => w.code === 'parse-error' || w.code === 'missing-source') ? 'partial' : 'complete',
    counts: {
      services: result.services.length,
      endpoints: result.endpoints.length,
      machineIdentities: result.machineIdentities.length,
      permissions: result.permissions.length,
      assignments: result.assignments.length,
      permissionHistory: result.permissionHistory.length,
      teams: result.teams.length,
      people: result.people.length,
      serviceOwnership: result.serviceOwnership.length,
      identityOwnership: result.identityOwnership.length,
      serviceDependencies: result.serviceDependencies.length,
      providerDependencies: result.providerDependencies.length,
      externalProviders: result.externalProviders.length,
      gatewayRoutes: result.gatewayRoutes.length,
      codeowners: result.codeowners.length,
      warnings: warnings.length,
    },
    ...result,
    warnings,
  };
}
