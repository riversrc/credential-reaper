import type { RemediationPlan } from '@credential-reaper/shared';
import { fetchGithubSource, type GithubEnv } from './github.ts';
import { buildRetirement, type Retirement } from './retire.ts';

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, step: string) {
    super(`GitHub returned HTTP ${status} while ${step}`);
    this.status = status;
  }
}

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_JUSTIFICATION_CHARS = 600;
export const PR_BRANCH_PREFIX = 'reaper/';

const apiBase = (env: GithubEnv): string => (env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');

async function github<T>(env: GithubEnv, token: string | undefined, step: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'credential-reaper-remediation',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new GithubError(res.status, step);
  return (res.status === 204 ? null : await res.json()) as T;
}

export interface PrTarget {
  repo: string;
  baseBranch: string;
}

export interface LoadedRetirement extends PrTarget {
  baseSha: string;
  retirement: Retirement;
}

/** Reads the head of the base branch and builds the verified change for one identity. Needs only read access. */
export async function loadRetirement(env: GithubEnv, target: PrTarget, identityName: string): Promise<LoadedRetirement> {
  if (!REPO_PATTERN.test(target.repo) || !BRANCH_PATTERN.test(target.baseBranch)) throw new Error('invalid repository or branch');
  const readToken = env.GITHUB_TOKEN ?? env.GITHUB_PR_TOKEN;
  const ref = await github<{ object?: { sha?: string } }>(env, readToken, 'reading the base branch', 'GET', `/repos/${target.repo}/git/ref/heads/${target.baseBranch}`);
  const baseSha = ref.object?.sha;
  if (!baseSha || !/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('unexpected response while reading the base branch');
  const source = await fetchGithubSource({ ...env, GITHUB_TOKEN: readToken }, target.repo, baseSha);
  const retirement = buildRetirement(source, identityName, { repo: target.repo, commitSha: baseSha });
  return { ...target, baseSha, retirement };
}

export function branchFor(plan: Pick<RemediationPlan, 'id'>, identityName: string): string {
  const planPart = plan.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'plan';
  return `${PR_BRANCH_PREFIX}retire-${identityName}-${planPart}`;
}

export const prTitle = (r: Retirement): string => `Retire declared-only identity ${r.identity.name} (${r.identity.id})`;

/** Untrusted text (the AI's justification) is flattened so it cannot mention users, add markup or inject long content. */
function plain(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code < 32 || code === 127 || '`@<>[]|'.includes(ch) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_JUSTIFICATION_CHARS);
}

export function prBody(plan: RemediationPlan, r: Retirement): string {
  const files = r.files.map((f) => `- ${f.change === 'deleted' ? 'delete' : 'edit'} \`${f.path}\``).join('\n');
  const checks = r.verification.map((v) => `- ${v.ok ? 'pass' : 'FAIL'}: ${v.check}`).join('\n');
  return [
    `Proposed by Credential Reaper from remediation plan \`${plan.id}\`, which a person approved.`,
    '',
    `**Identity:** \`${r.identity.name}\` (\`${r.identity.id}\`), declared \`${r.identity.homeServiceMode}\` in this repository.`,
    `**Why:** ${plain(plan.justification)}`,
    '',
    '### What this changes (configuration only)',
    files,
    '',
    '### Checks run on this change',
    'The changed repository was re-scanned in memory and compared with the current branch.',
    checks,
    '',
    '### What this does not do',
    "Merging removes the identity's declarations and bindings from this repository. It does not revoke, rotate or delete the real credential, and this repository cannot show whether the credential is still used at runtime. Revoke it in the secrets manager under your normal change process after merging.",
  ].join('\n');
}

export interface OpenedPullRequest {
  url: string;
  number: number;
  branch: string;
}

/**
 * Creates one commit on a new `reaper/` branch and opens a pull request into the base branch. The base branch itself
 * is never written to, and a merge stays a human decision. Needs `GITHUB_PR_TOKEN` (contents and pull-request write on this repository only).
 */
export async function openPullRequest(env: GithubEnv, loaded: LoadedRetirement, plan: RemediationPlan): Promise<OpenedPullRequest> {
  const token = env.GITHUB_PR_TOKEN;
  if (!token) throw new Error('GITHUB_PR_TOKEN is not set');
  const { repo, baseBranch, baseSha, retirement } = loaded;
  const branch = branchFor(plan, retirement.identity.name);

  const base = await github<{ tree?: { sha?: string } }>(env, token, 'reading the base commit', 'GET', `/repos/${repo}/git/commits/${baseSha}`);
  const baseTree = base.tree?.sha;
  if (!baseTree) throw new Error('unexpected response while reading the base commit');

  const entries = retirement.files.map((f) =>
    f.change === 'deleted' ? { path: f.path, mode: '100644', type: 'blob', sha: null } : { path: f.path, mode: '100644', type: 'blob', content: f.content ?? '' }
  );
  const tree = await github<{ sha: string }>(env, token, 'creating the change', 'POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
  const commit = await github<{ sha: string }>(env, token, 'creating the commit', 'POST', `/repos/${repo}/git/commits`, {
    message: `${prTitle(retirement)}\n\nRemediation plan ${plan.id}, proposed by Credential Reaper and approved by a person.`,
    tree: tree.sha,
    parents: [baseSha],
  });
  await github<unknown>(env, token, 'creating the branch', 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  try {
    const pr = await github<{ html_url: string; number: number }>(env, token, 'opening the pull request', 'POST', `/repos/${repo}/pulls`, {
      title: prTitle(retirement),
      head: branch,
      base: baseBranch,
      body: prBody(plan, retirement),
      maintainer_can_modify: false,
    });
    return { url: pr.html_url, number: pr.number, branch };
  } catch (e) {
    // Remove only the branch this call just created so a retry is possible.
    await github<unknown>(env, token, 'removing the unused branch', 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`).catch(() => {});
    throw e;
  }
}
