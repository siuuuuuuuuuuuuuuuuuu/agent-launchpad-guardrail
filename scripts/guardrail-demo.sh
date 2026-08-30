#!/usr/bin/env bash
# Guardrail demo — drives the full delegated-access scenario against a running
# server and prints the decision trace. Proves enforcement is server-side, not
# a hidden UI button.
#
#   npm run poc                       # in one terminal (or: npm run dev)
#   ./scripts/guardrail-demo.sh       # in another
#
# Env:
#   BASE   API base URL         (default http://localhost:3000)
#   TOKEN  APP_AUTH_TOKEN value  (default empty — loopback needs none)
#
# Without ARK_API_KEY the Runtime can't actually run Codex, so an *allowed*
# invoke returns 503 instead of 202. That's fine: enforcement still passed and
# the audit log still records the allow. The script treats 503 there as a warn.

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-}"
ALICE=(-H "X-User-Id: user-alice")
BOB=(-H "X-User-Id: user-bob")
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H "Content-Type: application/json")

pass=0; fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
req()  { curl -sS -w $'\n%{http_code}' "${AUTH[@]}" "$@"; }

# check <expected> <actual> <label>
check() {
  if [ "$1" = "$2" ]; then
    printf '  \033[32m✓\033[0m %s (HTTP %s)\n' "$3" "$2"; pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s — expected %s, got %s\n' "$3" "$1" "$2"; fail=$((fail + 1))
  fi
}
# check_allowed <actual> <label> — enforcement passed; 202 ideal, 503 = no ARK key
check_allowed() {
  case "$1" in
    202) printf '  \033[32m✓\033[0m %s (HTTP 202, run queued)\n' "$2"; pass=$((pass + 1)) ;;
    503) printf '  \033[33m!\033[0m %s (HTTP 503 — enforcement allowed it; Runtime needs ARK_API_KEY)\n' "$2"; pass=$((pass + 1)) ;;
    *)   printf '  \033[31m✗\033[0m %s — expected allow (202/503), got %s\n' "$2" "$1"; fail=$((fail + 1)) ;;
  esac
}

step "1. Alice creates an Agent — she becomes the owner"
r=$(req "${ALICE[@]}" "${JSON[@]}" -d '{"name":"Playground"}' "$BASE/api/agents")
check 201 "$(code "$r")" "POST /api/agents"
AGENT=$(body "$r" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4)
echo "  agent = $AGENT"

step "2. Bob tries to invoke without a grant — denied server-side"
r=$(req "${BOB[@]}" "${JSON[@]}" -d '{"content":"hi"}' "$BASE/api/agents/$AGENT/messages")
check 403 "$(code "$r")" "POST .../messages as Bob"

step "3. Alice grants Bob invoke-only"
r=$(req "${ALICE[@]}" "${JSON[@]}" -d '{"grantedTo":"user-bob","scopes":["invoke"]}' "$BASE/api/agents/$AGENT/grants")
check 201 "$(code "$r")" "POST .../grants"
GRANT=$(body "$r" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4)

step "4. Bob invokes — now allowed"
r=$(req "${BOB[@]}" "${JSON[@]}" -d '{"content":"hi"}' "$BASE/api/agents/$AGENT/messages")
check_allowed "$(code "$r")" "POST .../messages as Bob"

step "5. Bob tries to delete (outside his scope) — denied, even via direct API"
r=$(req "${BOB[@]}" -X DELETE "$BASE/api/agents/$AGENT")
check 403 "$(code "$r")" "DELETE /api/agents/:id as Bob"

step "6. Alice revokes Bob's grant"
r=$(req "${ALICE[@]}" -X DELETE "$BASE/api/agents/$AGENT/grants/$GRANT")
check 200 "$(code "$r")" "DELETE .../grants/:grantId"

step "7. Bob invokes again — denied, though it worked moments ago"
r=$(req "${BOB[@]}" "${JSON[@]}" -d '{"content":"hi again"}' "$BASE/api/agents/$AGENT/messages")
check 403 "$(code "$r")" "POST .../messages as Bob"

step "8. Alice is unaffected throughout"
r=$(req "${ALICE[@]}" "${JSON[@]}" -d '{"content":"owner still works"}' "$BASE/api/agents/$AGENT/messages")
check_allowed "$(code "$r")" "POST .../messages as Alice"

step "Audit trail — every decision, oldest first"
body "$(req "${ALICE[@]}" "$BASE/api/audit?target=$AGENT&limit=50")" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    for (const e of JSON.parse(s).entries.reverse()) {
      const p = e.payload || {};
      console.log(
        "  " + e.actor.id.padEnd(11) + " " + String(e.action).padEnd(12) +
        " " + e.decision.padEnd(5) + " [" + (p.checkpoint || "-") + "] " + (p.reason || ""));
    }
  });'

printf '\n\033[1mresult:\033[0m %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
