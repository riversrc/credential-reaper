import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RepoSource } from '../src/sync/source.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_PATHS = 5_000;

export function fsSource(root: string): RepoSource {
  const paths: string[] = [];
  let skippedLarge = 0;
  let capped = false;
  let skippedLinks = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (capped) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isSymbolicLink()) {
        skippedLinks++;
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        if (statSync(full).size > MAX_FILE_BYTES) {
          skippedLarge++;
          continue;
        }
        if (paths.length >= MAX_PATHS) {
          capped = true;
          return;
        }
        paths.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  if (skippedLarge > 0) console.warn(`warning: skipped ${skippedLarge} file(s) larger than ${MAX_FILE_BYTES} bytes`);
  if (skippedLinks > 0) console.warn(`warning: skipped ${skippedLinks} symlink(s) (not followed); the scan is marked incomplete`);
  if (capped) console.warn(`warning: stopped listing at ${MAX_PATHS} files; the scan may be incomplete`);
  paths.sort();
  return { paths, incomplete: skippedLarge > 0 || skippedLinks > 0 || capped, read: (p) => readFileSync(join(root, p), 'utf8') };
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
