// Sends a scan JSON file to a running Worker.
//   node scripts/ingest-scan.ts <scan.json> [--api http://localhost:8787]
import { readFileSync } from 'node:fs';
import type { RepositoryIngestResponse } from '@credential-reaper/shared';

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = (apiIndex >= 0 ? args[apiIndex + 1] : undefined) ?? 'http://localhost:8787';
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--api');
if (!file) {
  console.error('Usage: node scripts/ingest-scan.ts <scan.json> [--api http://localhost:8787]');
  process.exit(2);
}

const token = process.env.INGEST_TOKEN;
if (!token) {
  console.error('INGEST_TOKEN is not set. Export the same value the Worker was configured with.');
  process.exit(2);
}

const response = await fetch(`${api}/api/repository/scans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: readFileSync(file, 'utf8') });
const body = (await response.json()) as RepositoryIngestResponse & { message?: string; problems?: string[] };
if (!response.ok) {
  console.error(`Ingest failed (HTTP ${response.status}): ${body.message ?? 'unknown error'}`);
  for (const p of body.problems ?? []) console.error(`  - ${p}`);
  process.exit(1);
}

const { scan, identities } = body;
console.log(`Scan        ${scan.id}  (${scan.status}, commit ${scan.commitSha ?? 'none'})`);
console.log(`Records     added ${scan.added}, changed ${scan.changed}, unchanged ${scan.unchanged}, reappeared ${scan.reappeared}, removed ${scan.removed}`);
console.log(`Identities  declared ${identities.declared}, synced ${identities.synced}, skipped ${identities.skipped.length}`);
for (const s of identities.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
const persisted = Object.entries(scan.persisted).filter(([k]) => k.endsWith(':present')).map(([k, n]) => `${k.replace(':present', '')}=${n}`);
console.log(`Persisted   ${persisted.join(' ')}`);
