// Minimal HTTP client for SpacetimeDB 2.x's management/debug HTTP API
// (https://spacetimedb.com/docs/http/database/). We use this instead of the
// WebSocket client SDK (`spacetimedb/sdk`) because it's a plain
// request/response call per Worker invocation — no persistent connection or
// subscription state to manage across Worker isolate lifecycles, which is a
// much better fit for Cloudflare Workers' per-request model.
//
// Two endpoints are used:
//   POST /v1/database/:db/sql           — read-only SQL (SELECT only)
//   POST /v1/database/:db/call/:reducer — invoke a reducer (the only way to
//                                         write; SpacetimeDB requires all
//                                         mutations to go through reducers)
//
// Verified against a local `spacetime start` instance (CLI + `spacetimedb`
// npm package both v2.14.x) — see CLAUDE.md for exact commands.

export interface SpacetimeEnv {
  SPACETIME_URL: string;
  SPACETIME_DB_NAME: string;
  SPACETIME_AUTH_TOKEN?: string;
}

type AlgebraicType =
  | { String: [] }
  | { Bool: [] }
  | { U8: [] }
  | { U16: [] }
  | { U32: [] }
  | { U64: [] }
  | { I8: [] }
  | { I16: [] }
  | { I32: [] }
  | { I64: [] }
  | { F32: [] }
  | { F64: [] }
  | { Array: AlgebraicType }
  | { Product: { elements: SchemaElement[] } }
  | { Sum: { variants: SchemaElement[] } };

interface SchemaElement {
  name: { some: string };
  algebraic_type: AlgebraicType;
}

interface SqlStatementResult {
  schema: { elements: SchemaElement[] };
  rows: unknown[][];
}

/**
 * Decodes one SpacetimeDB row value per its AlgebraicType. Only covers the
 * types actually used in spacetime/module/src/index.ts (String, U32, Bool,
 * Array, Option-shaped Sum, Product) — not a general-purpose decoder for
 * every SpacetimeDB type.
 */
function decodeValue(type: AlgebraicType, value: unknown): unknown {
  if ('Array' in type) {
    return (value as unknown[]).map((v) => decodeValue(type.Array, v));
  }
  if ('Product' in type) {
    return decodeRow(type.Product.elements, value as unknown[]);
  }
  if ('Sum' in type) {
    const variants = type.Sum.variants;
    const isOption = variants.length === 2 && variants[0].name.some === 'some' && variants[1].name.some === 'none';
    const [tagIndex, payload] = value as [number, unknown];
    if (isOption) {
      return tagIndex === 0 ? decodeValue(variants[0].algebraic_type, payload) : null;
    }
    return { tag: variants[tagIndex]?.name.some, value: decodeValue(variants[tagIndex]!.algebraic_type, payload) };
  }
  // String, Bool, and all integer/float variants decode as their raw JSON value.
  return value;
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function decodeRow(elements: SchemaElement[], row: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  elements.forEach((element, i) => {
    result[snakeToCamel(element.name.some)] = decodeValue(element.algebraic_type, row[i]);
  });
  return result;
}

function authHeader(env: SpacetimeEnv): Record<string, string> {
  return env.SPACETIME_AUTH_TOKEN ? { Authorization: `Bearer ${env.SPACETIME_AUTH_TOKEN}` } : {};
}

/** Runs a single read-only SQL statement (no `;`-separated batches — the server rejects those). */
export async function sqlQuery<T>(env: SpacetimeEnv, query: string): Promise<T[]> {
  const response = await fetch(`${env.SPACETIME_URL}/v1/database/${env.SPACETIME_DB_NAME}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...authHeader(env) },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`SpacetimeDB SQL query failed (${response.status}): ${await response.text()}`);
  }
  const [result] = (await response.json()) as SqlStatementResult[];
  if (!result) return [];
  return result.rows.map((row) => decodeRow(result.schema.elements, row) as T);
}

/** Invokes a reducer by its snake_case wire name with a named-field JSON object. */
export async function callReducer(env: SpacetimeEnv, reducerName: string, args: object): Promise<void> {
  const response = await fetch(`${env.SPACETIME_URL}/v1/database/${env.SPACETIME_DB_NAME}/call/${reducerName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(env) },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`SpacetimeDB reducer "${reducerName}" failed (${response.status}): ${await response.text()}`);
  }
}

/** Safely embeds a string literal in a SQL statement (the HTTP SQL endpoint takes raw text, no bind params). */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Encodes a nullable value as a SpacetimeDB Option argument for a reducer call. */
export function encodeOption<T>(value: T | null | undefined): { some: T } | { none: Record<string, never> } {
  return value === null || value === undefined ? { none: {} } : { some: value };
}
