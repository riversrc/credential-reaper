import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RepoSource } from '../src/sync/source.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function fsSource(root: string): RepoSource {
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        paths.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  paths.sort();
  return { paths, read: (p) => readFileSync(join(root, p), 'utf8') };
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function gitSha(root: string): string | null {
  return git(root, ['rev-parse', 'HEAD']);
}

/** `owner/name` from the origin remote when it is a GitHub URL, otherwise the directory name. */
export function repoName(root: string): string {
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const m = remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : (root.split(sep).filter(Boolean).pop() ?? 'unknown');
}
