import type { RepoSource } from './source.ts';

export interface GithubEnv {
  /** Secret. Shared with the GitHub webhook; the webhook is refused (503) while unset. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Optional. Only needed to read a private repository. Needs read access to repository contents. */
  GITHUB_TOKEN?: string;
  /** Secret. Only used to open remediation pull requests: contents and pull-request write on the one repository. Never used by the scan. */
  GITHUB_PR_TOKEN?: string;
  /** Optional `owner/name`. When set, pushes from any other repository are ignored. */
  GITHUB_SYNC_REPO?: string;
  /** Optional. Only pushes to this branch are scanned. Defaults to the repository's default branch. */
  GITHUB_SYNC_BRANCH?: string;
  /** Optional. Defaults to https://api.github.com; only tests point it elsewhere. */
  GITHUB_API_BASE?: string;
}

export const MAX_WEBHOOK_BODY_CHARS = 2_000_000;
const MAX_TARBALL_BYTES = 30_000_000;
const MAX_EXTRACTED_BYTES = 80_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_PATHS = 5_000;
const FETCH_TIMEOUT_MS = 20_000;

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;
const LOGIN_PATTERN = /^[A-Za-z0-9_.@-]{1,40}$/;

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** Checks `X-Hub-Signature-256` over the raw body. `crypto.subtle.verify` compares in constant time. */
export async function verifyGithubSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  const match = header?.match(SIGNATURE_PATTERN);
  if (!match) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexToBytes(match[1]!), new TextEncoder().encode(rawBody));
}

export interface PushEvent {
  repo: string;
  sha: string;
  ref: string;
  defaultBranch: string | null;
  /** GitHub login of the pusher, only when it has a plain, short shape. */
  pusher: string | null;
}

/** Null when the payload is not a usable branch push (malformed, a branch deletion, an all-zero `after`). */
export function parsePushEvent(payload: unknown): PushEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, any>;
  const repo = p.repository?.full_name;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null;
  if (typeof p.after !== 'string' || !SHA_PATTERN.test(p.after) || /^0+$/.test(p.after)) return null;
  if (typeof p.ref !== 'string' || p.deleted === true) return null;
  const defaultBranch = typeof p.repository?.default_branch === 'string' ? p.repository.default_branch : null;
  const login = p.pusher?.name;
  return { repo, sha: p.after, ref: p.ref, defaultBranch, pusher: typeof login === 'string' && LOGIN_PATTERN.test(login) ? login : null };
}

/** Why a push is not scanned, or null when it should be. */
export function ignoredReason(env: GithubEnv, push: PushEvent): string | null {
  if (env.GITHUB_SYNC_REPO && env.GITHUB_SYNC_REPO.toLowerCase() !== push.repo.toLowerCase()) return 'repository is not the configured one';
  const branch = env.GITHUB_SYNC_BRANCH ?? push.defaultBranch;
  if (!branch) return 'no branch is configured and the payload has no default branch';
  if (push.ref !== `refs/heads/${branch}`) return `not a push to ${branch}`;
  return null;
}

const decoder = new TextDecoder();

function paxPath(data: Uint8Array): string | null {
  const text = decoder.decode(data);
  const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
  return m ? m[1]! : null;
}

/** Reads a (decompressed) tar archive into a RepoSource. The archive's single top-level directory is dropped. */
export function tarSource(tar: Uint8Array): RepoSource {
  const files = new Map<string, Uint8Array>();
  let incomplete = false;
  let nextPath: string | null = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, end: number): string => {
      const raw = header.subarray(start, end);
      const nul = raw.indexOf(0);
      return decoder.decode(nul === -1 ? raw : raw.subarray(0, nul));
    };
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      nextPath = paxPath(data) ?? nextPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      nextPath = decoder.decode(data).replace(/\0.*$/s, '');
      continue;
    }
    const prefix = field(345, 500);
    const path = nextPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    nextPath = null;
    if (type === '1' || type === '2') {
      incomplete = true;
      continue;
    }
    if (type !== '0') continue;
    const slash = path.indexOf('/');
    const rel = slash === -1 ? '' : path.slice(slash + 1);
    if (rel === '' || rel.split('/').some((s) => s === '..' || s === '')) continue;
    if (size > MAX_FILE_BYTES || files.size >= MAX_PATHS) {
      incomplete = true;
      continue;
    }
    files.set(rel, data);
  }
  const paths = [...files.keys()].sort();
  return {
    paths,
    incomplete,
    read(path) {
      const data = files.get(path);
      if (!data) throw new Error(`file not found: ${path}`);
      return decoder.decode(data);
    },
  };
}

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error('archive is larger than the allowed size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Downloads one commit as a single tarball (one subrequest), so a scan stays within Worker subrequest limits. */
export async function fetchGithubSource(env: GithubEnv, repo: string, sha: string): Promise<RepoSource> {
  if (!REPO_PATTERN.test(repo) || !SHA_PATTERN.test(sha)) throw new Error('invalid repository or commit');
  const base = (env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'credential-reaper-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`${base}/repos/${repo}/tarball/${sha}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`GitHub returned HTTP ${res.status} for the commit archive`);
  const compressed = await readCapped(res.body, MAX_TARBALL_BYTES);
  const tar = await readCapped(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_EXTRACTED_BYTES);
  return tarSource(tar);
}
