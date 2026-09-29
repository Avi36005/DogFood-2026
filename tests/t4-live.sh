#!/usr/bin/env bash
# Live T4 checks against a running instance (default http://localhost:3000, fixtures seeded).
# Read-only apart from a dry-run import, which writes nothing.
set -u
BASE="${BASE:-http://localhost:3000}"
SLUG="sample-hack-2026"
ORG="Cookie: forgeboard_session=org_demo_7f2a9c41d8e3b6a5"
pass=0; fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
tmp="$(mktemp -d)"

curl -s "$BASE/api/v1" > "$tmp/root.json"
check "REST API: /api/v1 answers"                         "grep -q '\"Forgeboard API\"' $tmp/root.json"
curl -s "$BASE/api/v1/openapi.json" > "$tmp/openapi.json"
check "REST API: OpenAPI 3.1 document is served"          "grep -q '\"openapi\":\"3.1' $tmp/openapi.json"
check "REST API: events list is public"                   "curl -sf $BASE/api/v1/events | grep -q '$SLUG'"
check "REST API: organizer data refused without a login"  "[ \$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v1/events/$SLUG/reviews) != 200 ]"

curl -s -H "$ORG" "$BASE/api/v1/events/$SLUG/export" > "$tmp/bundle.json"
check "Bulk export: organizer gets the event bundle"      "grep -q 'forgeboard.bundle/1' $tmp/bundle.json && grep -q 'prj_41' $tmp/bundle.json"
check "Bulk export: bundle carries no password hashes"    "! grep -q 'password_hash' $tmp/bundle.json"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data;process.stdout.write(JSON.stringify({bundle:b,dry_run:true}))' "$tmp/bundle.json" > "$tmp/import.json"
code=$(curl -s -o "$tmp/import.out" -w '%{http_code}' -X POST -H "$ORG" -H "Origin: $BASE" -H 'Content-Type: application/json' --data-binary @"$tmp/import.json" "$BASE/api/v1/events/$SLUG/import")
check "Bulk import: dry run of that bundle is accepted"   "[ $code -lt 300 ]"

check "Embeddable gallery: /embed/$SLUG renders projects" "curl -sf $BASE/embed/$SLUG | grep -qi 'project'"
check "Verifiable records: public key is published"       "curl -sf $BASE/api/verify-key | grep -q 'PUBLIC KEY'"
check "Verifiable records: no-account verify page"        "curl -sf $BASE/verify -o /dev/null"

echo
echo "Certificates (signed judge records) and webhooks (signing, SSRF guard, organizer-only) are"
echo "covered by tests/stretch.test.ts: npm test."
echo "$pass passed, $fail failed"
rm -rf "$tmp"
[ "$fail" -eq 0 ]
