import type { ScannedIdentity } from '@credential-reaper/shared';
import { diffScans } from './diff.ts';
import { scanRepository, type ScanContext } from './scan.ts';
import type { RepoSource } from './source.ts';

export type RetireRefusal = 'identity_not_in_repo' | 'not_declared_only' | 'unexpected_layout' | 'verification_failed';

export class RetireRefused extends Error {
  readonly code: RetireRefusal;
  constructor(code: RetireRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RetirementFile {
  path: string;
  change: 'deleted' | 'modified';
  /** Lines taken out of a modified file (a deleted file lists none). */
  removedLines: string[];
  /** New content of a modified file. */
  content: string | null;
}

export interface Retirement {
  identity: ScannedIdentity;
  files: RetirementFile[];
  /** Files that still mention the identity and are left as they are (for example documentation). */
  leftUntouched: string[];
  verification: Array<{ check: string; ok: boolean }>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,100}$/;
const MAX_LISTED = 20;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (line: string): number => line.length - line.trimStart().length;

function removeLines(text: string, matches: (line: string) => boolean): { content: string; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of text.split('\n')) (matches(line) ? removed : kept).push(line);
  return { content: kept.join('\n'), removed };
}

/** Removes the `- ref: <id>` list item and the deeper-indented lines under it. */
function removeConfigBinding(text: string, id: string): { content: string; removed: string[] } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s+ref:\\s*${escapeRe(id)}\\s*$`).test(l));
  if (start === -1) return { content: text, removed: [] };
  const itemIndent = indentOf(lines[start]!);
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== '' && indentOf(lines[end]!) > itemIndent) end++;
  return { content: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), removed: lines.slice(start, end) };
}

function recordPath(declaration: string, field: string): string | null {
  const m = declaration.match(new RegExp(`^\\s+${field}:\\s*(\\S+)\\s*$`, 'm'));
  return m ? m[1]! : null;
}

function overlay(source: RepoSource, files: RetirementFile[]): RepoSource {
  const gone = new Set(files.filter((f) => f.change === 'deleted').map((f) => f.path));
  const changed = new Map(files.filter((f) => f.change === 'modified').map((f) => [f.path, f.content ?? '']));
  return {
    paths: source.paths.filter((p) => !gone.has(p)),
    incomplete: source.incomplete,
    read: (p) => {
      const edited = changed.get(p);
      if (edited !== undefined) return edited;
      if (gone.has(p)) throw new Error(`file not found: ${p}`);
      return source.read(p);
    },
  };
}

const belongsTo = (id: string, key: string): boolean => key === id || key.startsWith(`${id}|`);

/**
 * Builds the repository change that removes one declared-only identity: its inventory records and the
 * bindings that name it. Nothing here touches a credential; the result is only ever proposed as a pull request.
 * The change is verified by re-scanning it in memory: exactly that identity's records must disappear and nothing else.
 */
export function buildRetirement(source: RepoSource, identityName: string, ctx: ScanContext): Retirement {
  if (source.incomplete) throw new RetireRefused('verification_failed', 'The repository snapshot is incomplete, so a change cannot be verified.');
  const before = scanRepository(source, ctx);
  if (before.status !== 'complete') throw new RetireRefused('verification_failed', 'The repository scan is not complete.');
  const identity = before.machineIdentities.find((i) => i.name === identityName);
  if (!identity) throw new RetireRefused('identity_not_in_repo', `${identityName} is not declared in the repository.`);
  const declaredOnly =
    identity.homeServiceMode === 'declared-only' &&
    identity.bindings.length > 0 &&
    identity.bindings.every((b) => b.mode === 'declared-only') &&
    identity.actsOnEndpointKeys.length === 0;
  if (!declaredOnly) {
    throw new RetireRefused('not_declared_only', `${identityName} is bound as active or acts on endpoints; only declared-only identities can be retired in a pull request.`);
  }
  if (!SLUG.test(identity.name)) throw new RetireRefused('unexpected_layout', 'The identity name is not in the expected form.');

  const id = identity.id;
  const paths = new Set(source.paths);
  const files: RetirementFile[] = [];
  const del = (path: string, mustContain: string): void => {
    if (!paths.has(path) || path.includes('..')) throw new RetireRefused('unexpected_layout', `Expected record ${path} was not found.`);
    if (!source.read(path).includes(mustContain)) throw new RetireRefused('unexpected_layout', `${path} does not belong to ${identity.name}.`);
    files.push({ path, change: 'deleted', removedLines: [], content: null });
  };

  const declarationPath = `inventory/identities/${identity.name}.yaml`;
  del(declarationPath, `id: ${id}`);
  const declaration = source.read(declarationPath);
  for (const field of ['permissionAssignments', 'ownership']) {
    const path = recordPath(declaration, field);
    if (path) {
      if (!path.startsWith('inventory/')) throw new RetireRefused('unexpected_layout', `${field} record is outside inventory/.`);
      del(path, `identityId: ${id}`);
    }
  }

  const envName = identity.credential.secretRefEnv;
  for (const binding of identity.bindings) {
    const service = binding.serviceId;
    if (!SLUG.test(service)) throw new RetireRefused('unexpected_layout', 'A service name is not in the expected form.');
    const edit = (path: string, apply: (text: string) => { content: string; removed: string[] }): void => {
      if (!paths.has(path)) return;
      const result = apply(source.read(path));
      if (result.removed.length > 0) files.push({ path, change: 'modified', removedLines: result.removed, content: result.content });
    };
    const base = `services/${service}`;
    edit(`${base}/config/service.config.yaml`, (t) => removeConfigBinding(t, id));
    edit(`${base}/src/identities.ts`, (t) => removeLines(t, (l) => new RegExp(`\\{\\s*id:\\s*'${escapeRe(id)}'\\s*,`).test(l)));
    edit(`${base}/README.md`, (t) => removeLines(t, (l) => new RegExp(`^\\s*[-*]\\s+\`${escapeRe(id)}\``).test(l)));
    if (envName && ENV_NAME.test(envName)) edit(`${base}/.env.example`, (t) => removeLines(t, (l) => l.startsWith(`${envName}=`)));
  }
  if (!files.some((f) => f.change === 'modified')) {
    throw new RetireRefused('unexpected_layout', `No bindings for ${identity.name} were found in the owning service, so the change would leave dangling references.`);
  }

  const after = scanRepository(overlay(source, files), ctx);
  const changes = diffScans(before, after);
  const verification = [
    { check: 'The re-scan of the changed repository is complete', ok: after.status === 'complete' },
    { check: `${identity.name} no longer appears in the inventory`, ok: !after.machineIdentities.some((i) => i.id === id) },
    { check: `Only records of ${identity.name} were removed`, ok: changes.length > 0 && changes.every((c) => c.kind === 'removed' && belongsTo(id, c.key)) },
    { check: 'The change adds no scan warnings', ok: after.warnings.length <= before.warnings.length },
  ];
  if (verification.some((v) => !v.ok)) {
    throw new RetireRefused('verification_failed', `Verification failed: ${verification.filter((v) => !v.ok).map((v) => v.check).join('; ')}.`);
  }

  const changed = new Set(files.map((f) => f.path));
  const leftUntouched: string[] = [];
  for (const path of source.paths) {
    if (changed.has(path) || leftUntouched.length >= MAX_LISTED) continue;
    try {
      const text = source.read(path);
      if (text.includes(id) || text.includes(identity.name)) leftUntouched.push(path);
    } catch {
      // unreadable files are not reported
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { identity, files, leftUntouched, verification };
}
