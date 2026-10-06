#!/usr/bin/env bash
# End-to-end check of the verification app on a local stand-in for Supabase:
# Postgres with schema.sql, PostgREST, the real `source` Edge Function under
# Deno, and the app in Chromium. Needs, on PATH or in env:
#   WORKBENCH (a pharma-analog-uptake-workbench checkout, for gold; default: a
#   sibling folder), PGHOST/PGPORT (a superuser connection), POSTGREST, DENO, node with playwright
#   (NODE_PATH pointing at its node_modules), optional CHROMIUM, and PYTHON
#   with openpyxl (default python3).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$(mktemp -d)}"
DB="${DB:-gv_e2e}"
SECRET="e2e-local-jwt-secret-at-least-32-characters"
REST_PORT=3901 FN_PORT=8000 GW_PORT=3900  # Deno.serve listens on 8000
mkdir -p "$OUT"
echo "output in $OUT"

python3 "$APP/scripts/build_rows.py" --out "$OUT/rows.json"

psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/supabase_stub.sql" -f "$APP/supabase/schema.sql" 2>&1 | grep -v NOTICE || true
psql -q -d "$DB" -c "insert into team_members values ('asha@team.test', 'Asha'), ('ben@team.test', 'Ben')"

node -e '
const crypto = require("crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (claims) => { const h = b64({ alg: "HS256", typ: "JWT" }); const p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 7200 });
  return `${h}.${p}.${crypto.createHmac("sha256", process.argv[1]).update(`${h}.${p}`).digest("base64url")}`; };
const user = (email) => sign({ role: "authenticated", aud: "authenticated", email });
console.log(JSON.stringify({ asha: user("asha@team.test"), ben: user("ben@team.test"), outsider: user("someone@else.test"),
  anon: sign({ role: "anon" }), service: sign({ role: "service_role" }) }));' "$SECRET" > "$OUT/tokens.json"
tok() { python3 -c "import json,sys; print(json.load(open('$OUT/tokens.json'))['$1'])"; }

cat > "$OUT/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authenticator@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-port = $REST_PORT
CONF
# A socket directory as PGHOST needs the libpq "host=" form.
if [[ "${PGHOST:-}" == /* ]]; then
  sed -i "s|^db-uri.*|db-uri = \"postgres://authenticator:authenticator@/$DB?host=$PGHOST\&port=${PGPORT:-5432}\"|" "$OUT/postgrest.conf"
fi
"$POSTGREST" "$OUT/postgrest.conf" > "$OUT/postgrest.log" 2>&1 & PIDS=($!)
SUPABASE_URL="http://localhost:$GW_PORT" SUPABASE_ANON_KEY="$(tok anon)" SUPABASE_SERVICE_ROLE_KEY="$(tok service)" \
  "$DENO" run --allow-net --allow-env "$APP/supabase/functions/source/index.ts" > "$OUT/function.log" 2>&1 & PIDS+=($!)
echo 'export default {};' > "$OUT/config.js"
node "$HERE/gateway.mjs" "$GW_PORT" "$APP" "$REST_PORT" "$FN_PORT" "$OUT/config.js" > "$OUT/gateway.log" 2>&1 & PIDS+=($!)
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf "http://localhost:$GW_PORT/rest/v1/" >/dev/null 2>&1 && curl -s "http://localhost:$FN_PORT/" >/dev/null 2>&1 && break
  sleep 1
done

STATUS=0
node "$HERE/e2e.mjs" "http://localhost:$GW_PORT" "$OUT/rows.json" "$OUT" "$OUT/tokens.json" "${CHROMIUM:-}" || STATUS=1
"${PYTHON:-python3}" "$HERE/check_db.py" "$OUT/e2e_result.json" -d "$DB" || STATUS=1
echo "e2e status $STATUS; screenshots and logs in $OUT"
exit $STATUS
