// Offline scan of a local inventory-manifest repository (for example the Arasaka demo repo).
//   node scripts/scan-repo.ts <repo-path> [--out scan.json] [--expect-arasaka] [--warnings]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scanRepository } from '../src/sync/scan.ts';
import { ARASAKA_EXPECTED } from './arasaka-expected.ts';
import { fsSource, gitSha, repoName } from './fs-source.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');

if (!target || (outIndex >= 0 && !outPath)) {
  console.error('Usage: node scripts/scan-repo.ts <repo-path> [--out scan.json] [--expect-arasaka] [--warnings]');
  process.exit(2);
}

const root = resolve(target);
const scan = scanRepository(fsSource(root), { repo: repoName(root), commitSha: gitSha(root) });

console.log(`Repository  ${scan.repo}`);
console.log(`Commit      ${scan.commitSha ?? '(not a git checkout)'}`);
console.log(`Status      ${scan.status}`);
console.log('');
const width = Math.max(...Object.keys(scan.counts).map((k) => k.length));
let mismatched = 0;
for (const [name, actual] of Object.entries(scan.counts)) {
  const expected = flag('--expect-arasaka') ? ARASAKA_EXPECTED[name as keyof typeof ARASAKA_EXPECTED] : undefined;
  const verdict = expected === undefined ? '' : actual === expected ? `  expected ${expected}  OK` : `  expected ${expected}  MISMATCH`;
  if (expected !== undefined && actual !== expected) mismatched++;
  console.log(`  ${name.padEnd(width)}  ${String(actual).padStart(4)}${verdict}`);
}

if (scan.warnings.length > 0) {
  const byCode = new Map<string, number>();
  for (const w of scan.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  console.log(`\nWarnings: ${[...byCode].map(([c, n]) => `${c}=${n}`).join(', ')}`);
  for (const w of flag('--warnings') ? scan.warnings : scan.warnings.slice(0, 10)) console.log(`  [${w.code}] ${w.sourcePath}: ${w.message}`);
  if (!flag('--warnings') && scan.warnings.length > 10) console.log(`  ... ${scan.warnings.length - 10} more (use --warnings)`);
}

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(scan, null, 2) + '\n');
  console.log(`\nWrote ${resolve(outPath)}`);
}

if (flag('--expect-arasaka')) {
  console.log(mismatched === 0 ? '\nAll Arasaka baseline counts match.' : `\n${mismatched} count(s) do not match the Arasaka baseline.`);
  process.exit(mismatched === 0 ? 0 : 1);
}
