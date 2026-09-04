#!/bin/bash
# Forge Alpha Release Verification
# Runs: typecheck → unit tests → benchmark → integration demos → fresh-install flow
# Exit 0 = all pass, exit 1 = any failure

set -euo pipefail
# Repo root derived from this script's location so the check runs anywhere
# (developer machine or CI), not just at one hard-coded path.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0

check() {
  local name="$1"; local cmd="$2"
  TOTAL=$((TOTAL+1))
  if eval "$cmd" > /tmp/forge-release-check.log 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name"; PASS=$((PASS+1))
  else
    echo -e "  ${RED}✗${NC} $name"; cat /tmp/forge-release-check.log | tail -10; FAIL=$((FAIL+1))
  fi
}

echo "==== Forge Alpha Release Verification ===="
echo ""

echo "--- Typecheck ---"
check "main typecheck"        "cd $ROOT && npx tsc --noEmit"
check "bench typecheck"       "cd $ROOT && npx tsc --noEmit -p tsconfig.benchmark.json"
check "desktop typecheck"     "cd $ROOT/desktop && npx tsc --noEmit"

echo ""
echo "--- Unit Tests ---"
check "verification tests"    "cd $ROOT && node --import tsx --test src/verification/verify.test.ts"
check "recovery tests"        "cd $ROOT && node --import tsx --test src/recovery/recovery.test.ts"
check "schema tests"          "cd $ROOT && node --import tsx --test src/core/persistence/schema.test.ts"
check "guard policy tests"    "cd $ROOT && node --import tsx --test src/guard/policy.test.ts"
check "guard extension tests" "cd $ROOT && node --import tsx --test src/guard/extension.test.ts"
check "approval-hub tests"    "cd $ROOT && node --import tsx --test src/server/approval-hub.test.ts"
check "undo tests"            "cd $ROOT && node --import tsx --test src/server/undo.test.ts"
check "pi-models tests"       "cd $ROOT && node --import tsx --test src/server/pi-models.test.ts"
check "task-manager tests"    "cd $ROOT && node --import tsx --test src/server/task-manager.test.ts"
check "intent-router tests"   "cd $ROOT && node --import tsx --test src/server/intent-router.test.ts"
check "pi-adapter tests"     "cd $ROOT && node --import tsx --test src/runtime/pi/pi-adapter.test.ts"

echo ""
echo "--- Integration ---"
check "runtime seam test"     "cd $ROOT && npx tsx src/runtime/seam-test.ts"
check "benchmark (5 golden)"  "cd $ROOT && npm run bench"

echo ""
for d in crash verify dynplan skill dag evaluate serve; do
  check "$d demo" "cd $ROOT && npx tsx src/cli/$d-demo.ts"
done

echo ""
echo "---- Fresh install flow ----"
FRESH_DIR="/tmp/forge-fresh-$(date +%s)"
mkdir -p "$FRESH_DIR"
export FORGE_HOME="$FRESH_DIR"
export FORGE_TASKS_DIR="$FRESH_DIR/tasks"
export FORGE_EVENTS_DIR="$FRESH_DIR/events"
export FORGE_MEMORY_PATH="$FRESH_DIR/memory.json"
export FORGE_RUNTIME=fake

check "fresh serve starts"     "cd $ROOT && npx tsx src/cli/serve.ts --port 0 & sleep 3 && kill %1 2>/dev/null"
rm -rf "$FRESH_DIR"

echo ""
echo "==== Summary: $PASS/$TOTAL passed, $FAIL failed ===="

# Cleanup orphan processes
pkill -f "rpc-entry" 2>/dev/null || true
pkill -f "src/cli/serve" 2>/dev/null || true

if [ $FAIL -gt 0 ]; then exit 1; fi
