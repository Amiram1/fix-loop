#!/usr/bin/env bash
# Creates the test user FixLoop's reproduce stage logs in as.
# Idempotent: a 4xx on an existing user is fine.
set -euo pipefail
BASE_URL="${FIXLOOP_BASE_URL:-http://localhost:3456}"

curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$BASE_URL/api/v1/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"fixloop","email":"fixloop@example.test","password":"fixloop-test-pw-1"}' || true

echo "seed complete"
