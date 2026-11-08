// Validates an untrusted repository scan before anything is written. The result is rebuilt field by field from
// a per-list spec, so unknown fields never reach the database and the output has exactly the shape of
// RepositoryScan. Malformed or unsupported input yields a list of problems, never a partial write.
import type { RepositoryScan } from '@credential-reaper/shared';

export const MAX_SCAN_BODY_CHARS = 5_000_000;

const MAX_PROBLEMS = 40;
const MAX_STRING = 2_000;
const MAX_LIST = 5_000;
const MAX_NESTED = 500;

const IDENTITY_TYPES = ['service-account', 'api-key', 'oauth-app', 'ssh-key', 'certificate', 'bot-account', 'webhook'];
const EVIDENCE_TYPES = ['repository-declaration', 'source-reference'];
const CONFIDENCES = ['high', 'medium', 'low'];
const WARNING_CODES = ['parse-error', 'missing-source', 'unknown-reference', 'cross-source-mismatch', 'duplicate-key', 'secret-flag'];
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const REPO_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
// Mask shape: a short prefix, a run of '*', a short suffix. Anything longer could carry a real secret.
const MASK_PATTERN = /^[^*]{0,8}\*{4,}[^*]{0,4}$/;
const MAX_MASK_CHARS = 40;
// Conservative reference grammar for storage / secretRef / secretRefEnv: a URI-ish location, a name or an env var.
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,199}$/;
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bnvapi-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bxox[abp]-/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[0-9a-fA-F]{32,}/,
];
const LONG_TOKEN = /[A-Za-z0-9+]{32,}/g;

/** True for strings that look like a credential. Never echo the value in an error. */
export function looksLikeSecret(value: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(value))) return true;
  // High-entropy base64-ish run: mixed case and digits distinguishes it from long identifiers.
  return (value.match(LONG_TOKEN) ?? []).some((tok) => /[a-z]/.test(tok) && /[A-Z]/.test(tok) && /\d/.test(tok));
}

export const isMaskedPreview = (v: string): boolean => v.length <= MAX_MASK_CHARS && MASK_PATTERN.test(v);

type FieldSpec = 's' | 's?' | 'b' | 'n' | 'n?' | 'S' | { object: Spec } | { objects: Spec };
type Spec = Record<string, FieldSpec>;

const BINDING: Spec = { serviceId: 's', usage: 's?', mode: 's?', declaredInIdentityBindingsSource: 'b' };
const CREDENTIAL: Spec = { storage: 's?', secretRef: 's?', secretRefEnv: 's?', maskedPreview: 's?', lastRotatedOn: 's?' };

const LIST_SPECS: Record<string, Spec> = {
  services: { id: 's', name: 's', description: 's?', lifecycle: 's?', tier: 's?', dataClassification: 's?', owningTeamId: 's?', port: 'n?', basePath: 's?' },
  endpoints: {
    serviceId: 's', method: 's', path: 's', operationId: 's?', permissionId: 's?', identityId: 's?', authenticated: 'b',
    authMode: 's?', deprecated: 'b', declaredInOpenApi: 'b', declaredInRouteSource: 'b',
  },
  machineIdentities: {
    id: 's', name: 's', type: 's', purpose: 's?', environment: 's?', declaredStatus: 's?', owningServiceId: 's?', introducedOn: 's?',
    introducedBy: 's?', expiresOn: 's?', credential: { object: CREDENTIAL }, tags: 'S', homeServiceMode: 's?',
    bindings: { objects: BINDING }, actsOnEndpointKeys: 'S',
  },
  permissions: { id: 's', resource: 's?', action: 's?', level: 's?', sensitivity: 's?', description: 's?' },
  assignments: { identityId: 's', permissionId: 's', environment: 's?', resource: 's?', reviewStatus: 's?', grantedOn: 's?' },
  permissionHistory: { identityId: 's', permissionId: 's?', date: 's?', change: 's?', ticket: 's?', note: 's?' },
  teams: { id: 's', name: 's', leadId: 's?', securityContactId: 's?', channel: 's?', githubTeam: 's?', memberIds: 'S' },
  people: { id: 's', name: 's', title: 's?', teamId: 's?', status: 's?', repositoryRole: 's?', githubHandle: 's?', joined: 's?', left: 's?' },
  serviceOwnership: { serviceId: 's', owningTeamId: 's?', maintainerIds: 'S', tier: 's?', status: 's?', reviewCadence: 's?' },
  identityOwnership: {
    identityId: 's', owningTeamId: 's?', owningServiceId: 's?', primaryOwnerId: 's?', ownershipStatus: 's?',
    ownerEmploymentStatus: 's?', lastReviewedOn: 's?', note: 's?',
  },
  serviceDependencies: { fromServiceId: 's', toServiceId: 's', baseUrlEnv: 's?', callsAs: 'S', clientDeclaredInSource: 'b', callSiteCount: 'n' },
  providerDependencies: {
    serviceId: 's', providerId: 's', baseUrlEnv: 's?', callsAs: 'S', declaredEvidence: 's?', clientDeclaredInSource: 'b', callSiteCount: 'n',
  },
  externalProviders: { id: 's', name: 's', category: 's?', domain: 's?', baseUrlEnv: 's?', contractEndsOn: 's?', owningTeamId: 's?' },
  gatewayRoutes: { pathPrefix: 's', upstreamServiceId: 's?', authMode: 's?', forwardAsIdentityId: 's?' },
  codeowners: { pattern: 's', owners: 'S' },
};

export const SCAN_LIST_NAMES = Object.keys(LIST_SPECS);

export type ValidationResult = { ok: true; scan: RepositoryScan } | { ok: false; problems: string[] };

class Problems {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    if (this.list.length < MAX_PROBLEMS) this.list.push(`${path}: ${message}`);
    else if (this.list.length === MAX_PROBLEMS) this.list.push('... further problems omitted');
  }
  get any(): boolean {
    return this.list.length > 0;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readString(v: unknown, path: string, p: Problems, nullable: boolean): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string') {
    p.add(path, nullable ? 'must be a string or null' : 'must be a string');
    return null;
  }
  if (v.length > MAX_STRING) {
    p.add(path, `longer than ${MAX_STRING} characters`);
    return null;
  }
  // A commit SHA is legitimately long hex; it is validated separately.
  if (!path.endsWith('commitSha') && looksLikeSecret(v)) {
    p.add(path, 'contains a value that looks like a secret; nothing was stored');
    return null;
  }
  return v;
}

function readStringArray(v: unknown, path: string, p: Problems): string[] {
  if (!Array.isArray(v)) {
    p.add(path, 'must be an array of strings');
    return [];
  }
  if (v.length > MAX_NESTED) p.add(path, `more than ${MAX_NESTED} entries`);
  return v.slice(0, MAX_NESTED).flatMap((item, i) => {
    const s = readString(item, `${path}[${i}]`, p, false);
    return s === null ? [] : [s];
  });
}

function readObject(raw: unknown, spec: Spec, path: string, p: Problems): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(raw)) {
    p.add(path, 'must be an object');
    return out;
  }
  for (const [field, kind] of Object.entries(spec)) {
    const v = raw[field];
    const at = `${path}.${field}`;
    if (kind === 's' || kind === 's?') out[field] = readString(v, at, p, kind === 's?');
    else if (kind === 'b') {
      if (typeof v !== 'boolean') p.add(at, 'must be a boolean');
      out[field] = v === true;
    } else if (kind === 'n' || kind === 'n?') {
      if (v === null && kind === 'n?') out[field] = null;
      else if (typeof v === 'number' && Number.isFinite(v)) out[field] = v;
      else {
        p.add(at, kind === 'n?' ? 'must be a number or null' : 'must be a number');
        out[field] = kind === 'n?' ? null : 0;
      }
    } else if (kind === 'S') out[field] = readStringArray(v, at, p);
    else if ('object' in kind) out[field] = readObject(v, kind.object, at, p);
    else if (!Array.isArray(v)) {
      p.add(at, 'must be an array');
      out[field] = [];
    } else {
      if (v.length > MAX_NESTED) p.add(at, `more than ${MAX_NESTED} entries`);
      out[field] = v.slice(0, MAX_NESTED).map((item, i) => readObject(item, kind.objects, `${at}[${i}]`, p));
    }
  }
  return out;
}

function readProvenance(raw: unknown, repo: string, path: string, p: Problems) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    p.add(path, 'must be an array of 1 to 50 provenance entries');
    return [];
  }
  return raw.map((item, i) => {
    const at = `${path}[${i}]`;
    const o = readObject(item, { repo: 's', sourcePath: 's', commitSha: 's?', discoveredAt: 's', evidenceType: 's', confidence: 's' }, at, p);
    if (o.commitSha !== null && !/^[0-9a-f]{7,64}$/.test(String(o.commitSha ?? ''))) p.add(`${at}.commitSha`, 'must be a lowercase hex git SHA or null');
    if (o.repo !== repo) p.add(`${at}.repo`, `must equal the scan repo "${repo}"`);
    if (!EVIDENCE_TYPES.includes(o.evidenceType as string)) p.add(`${at}.evidenceType`, `unsupported evidence type; expected ${EVIDENCE_TYPES.join(' or ')}`);
    if (!CONFIDENCES.includes(o.confidence as string)) p.add(`${at}.confidence`, `must be one of ${CONFIDENCES.join(', ')}`);
    if (Number.isNaN(Date.parse(o.discoveredAt as string))) p.add(`${at}.discoveredAt`, 'must be an ISO 8601 timestamp');
    return o;
  });
}

export function validateScan(input: unknown): ValidationResult {
  const p = new Problems();
  if (!isObject(input)) return { ok: false, problems: ['body: must be a JSON object'] };

  if (input.schemaVersion !== 1) p.add('schemaVersion', `unsupported (got ${JSON.stringify(input.schemaVersion)}, supported: 1)`);
  const repo = readString(input.repo, 'repo', p, false) ?? '';
  if (repo && !REPO_PATTERN.test(repo)) p.add('repo', 'must match [A-Za-z0-9._/-]{1,200}');
  const commitSha = readString(input.commitSha, 'commitSha', p, true);
  if (commitSha !== null && !/^[0-9a-f]{7,64}$/.test(commitSha)) p.add('commitSha', 'must be a lowercase hex git SHA or null');
  const scannedAt = readString(input.scannedAt, 'scannedAt', p, false) ?? '';
  if (scannedAt && Number.isNaN(Date.parse(scannedAt))) p.add('scannedAt', 'must be an ISO 8601 timestamp');
  const manifestPath = readString(input.manifestPath, 'manifestPath', p, false) ?? '';
  if (input.status !== 'complete' && input.status !== 'partial') p.add('status', 'must be "complete" or "partial"');

  const out: Record<string, unknown[]> = {};
  for (const name of SCAN_LIST_NAMES) {
    const raw = input[name];
    if (!Array.isArray(raw)) {
      p.add(name, 'must be an array');
      out[name] = [];
      continue;
    }
    if (raw.length > MAX_LIST) {
      p.add(name, `more than ${MAX_LIST} records`);
      out[name] = [];
      continue;
    }
    const seen = new Set<string>();
    out[name] = raw.map((item, i) => {
      const at = `${name}[${i}]`;
      const record = readObject(item, LIST_SPECS[name], at, p);
      const key = readString(isObject(item) ? item.key : undefined, `${at}.key`, p, false) ?? '';
      if (!key || key.length > 512) p.add(`${at}.key`, 'must be a non-empty string of at most 512 characters');
      if (seen.has(key)) p.add(`${at}.key`, `duplicate key "${key}" in ${name}`);
      seen.add(key);
      const provenance = readProvenance(isObject(item) ? item.provenance : undefined, repo, `${at}.provenance`, p);
      return { key, ...record, provenance };
    });
  }

  const identities = out.machineIdentities as { id: string; type: string; credential: { maskedPreview: string | null } }[];
  identities.forEach((identity, i) => {
    const at = `machineIdentities[${i}]`;
    if (!ID_PATTERN.test(identity.id ?? '')) p.add(`${at}.id`, 'must match [A-Za-z0-9._:-]{1,64}');
    if (!IDENTITY_TYPES.includes(identity.type)) p.add(`${at}.type`, `unsupported identity type "${identity.type}"; expected one of ${IDENTITY_TYPES.join(', ')}`);
    const masked = identity.credential?.maskedPreview;
    if (masked && !isMaskedPreview(masked)) {
      p.add(`${at}.credential.maskedPreview`, `must be a masked preview: up to 8 leading characters, 4 or more "*", up to 4 trailing characters, at most ${MAX_MASK_CHARS} in total`);
    }
    for (const field of ['storage', 'secretRef', 'secretRefEnv'] as const) {
      const ref = (identity.credential as Record<string, string | null> | undefined)?.[field];
      if (ref && !REFERENCE_PATTERN.test(ref)) p.add(`${at}.credential.${field}`, 'must be a reference (location or name), not a value');
    }
  });

  const rawWarnings = Array.isArray(input.warnings) ? input.warnings : (p.add('warnings', 'must be an array'), []);
  const warnings = rawWarnings.slice(0, 1_000).map((w, i) => {
    const o = readObject(w, { code: 's', sourcePath: 's', message: 's' }, `warnings[${i}]`, p);
    if (!WARNING_CODES.includes(o.code as string)) p.add(`warnings[${i}].code`, 'unsupported warning code');
    return o;
  });

  if (isObject(input.counts)) {
    for (const name of SCAN_LIST_NAMES) {
      if (input.counts[name] !== out[name].length) p.add(`counts.${name}`, `declares ${JSON.stringify(input.counts[name])} but the list holds ${out[name].length}`);
    }
  } else p.add('counts', 'must be an object');

  if (p.any) return { ok: false, problems: p.list };

  const counts = Object.fromEntries([...SCAN_LIST_NAMES.map((n) => [n, out[n].length]), ['warnings', warnings.length]]);
  const scan = { schemaVersion: 1, repo, commitSha, scannedAt, manifestPath, status: input.status, counts, ...out, warnings } as unknown as RepositoryScan;
  return { ok: true, scan };
}
