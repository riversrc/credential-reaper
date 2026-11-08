#!/usr/bin/env bash
# Creates a dedicated SpacetimeDB service identity for the Cloudflare Worker and registers it in the
# module's private `authorized_caller` table. Run it as the database OWNER (your `spacetime login`
# identity): the INSERT is raw SQL DML, which SpacetimeDB only accepts from the owner.
#
#   [SPACETIME_HOST_URL=http://localhost:3000] spacetime/scripts/provision-worker-identity.sh <database> <token-file> [server-alias] [label]
#
# The token is written to <token-file> (mode 600) and is never printed. Put its content into
# SPACETIME_AUTH_TOKEN (workers/api/.dev.vars locally, `wrangler secret put` when deployed). Do not
# use the owner's own token for the Worker: a service token can only call reducers and read the
# gated views; it cannot run SQL DML, publish, delete the database or read logs.
set -euo pipefail

DB="${1:?usage: $0 <database> <token-file> [server-alias] [label]}"
TOKEN_FILE="${2:?usage: $0 <database> <token-file> [server-alias] [label]}"
SERVER="${3:-local}"
LABEL="${4:-worker}"

if [[ ! "$DB" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then echo "invalid database name" >&2; exit 2; fi
if [[ ! "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then echo "invalid label" >&2; exit 2; fi
if [ -e "$TOKEN_FILE" ]; then echo "$TOKEN_FILE already exists; refusing to overwrite it" >&2; exit 2; fi

HOST_URL="${SPACETIME_HOST_URL:-http://localhost:3000}"   # must be the host that serves $SERVER

umask 077
RESPONSE="$(curl -sS --fail -X POST "$HOST_URL/v1/identity")"
IDENTITY="$(printf '%s' "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["identity"])')"
printf '%s' "$RESPONSE" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["token"])' > "$TOKEN_FILE"
unset RESPONSE
chmod 600 "$TOKEN_FILE"

if [[ ! "$IDENTITY" =~ ^[0-9a-f]{64}$ ]]; then rm -f "$TOKEN_FILE"; echo "unexpected identity format" >&2; exit 1; fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
spacetime sql --server "$SERVER" "$DB" \
  "INSERT INTO authorized_caller (identity, label, added_at) VALUES (0x$IDENTITY, '$LABEL', '$NOW')"

echo "registered identity 0x$IDENTITY as '$LABEL' in $DB"
echo "token saved to $TOKEN_FILE (mode 600, not printed)"
