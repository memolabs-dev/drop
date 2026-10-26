#!/usr/bin/env bash
# Local end-to-end demo with real processes, on 127.0.0.1:
#  - a relay;
#  - "VPS", which executes production.error_summary on a fixture log (deterministic, no LLM), approved by Guillaume;
#  - "Julie", which executes repo.answer on her own fixture repo with her own LLM key (high sensitivity: she reviews
#    the answer before it leaves);
#  - "Guillaume", who asks both through the MCP server, like Claude Code would.
# repo.answer uses the OpenRouter model only when OPENROUTER_API_KEY is explicitly supplied.
# The deterministic offline path does not access Keychain or a model provider.
# Usage: scripts/demo-local.sh [--offline] [workdir]
# --offline (or no OPENROUTER_API_KEY) runs only the deterministic scenario; no cloud model or keychain reads.
# Workdir defaults to a new temp dir; demo node state remains inside it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OFFLINE=0
if [[ "${1:-}" == "--offline" ]]; then OFFLINE=1; shift; fi
if [[ "${1:-}" == --* ]] || [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [--offline] [workdir]" >&2
  exit 64
fi
WORK="${1:-$(mktemp -d -t drop-demo)}"
DROP="node $ROOT/packages/node/src/cli.ts"
RELAY="node $ROOT/packages/relay/src/cli.ts"
PROBE="node $ROOT/packages/requester-mcp/scripts/probe.ts"
PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Work dir: $WORK"
mkdir -p "$WORK"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$WORK/app.log" <<LOG
$NOW INFO checkout ok user=alice@example.com amount=42.00EUR
$NOW ERROR payment timeout order=9f1c2b7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f card=4242
$NOW ERROR payment timeout order=1b2c3d4e-0000-4c3d-8e9f-0a1b2c3d4e5f ip=10.0.0.7
$NOW ERROR db connection refused host=db.internal key=sk-ant-api03-notarealkeybutlookslikeone
$NOW FATAL unexpected crash in worker token=abcd
LOG
cat > "$WORK/error-summary.json" <<CFG
{ "services": { "api": { "source": { "kind": "file", "path": "$WORK/app.log" } } },
  "errorPatterns": [ { "name": "PAYMENT_TIMEOUT", "regex": "payment timeout" }, { "name": "DB_DOWN", "regex": "connection refused" } ],
  "errorLineRegex": "\\\\b(ERROR|FATAL)\\\\b", "degradedThreshold": 2 }
CFG

mkdir -p "$WORK/julie-repo/src" "$WORK/julie-repo/docs"
cat > "$WORK/julie-repo/src/theme.ts" <<'TS'
export type Theme = 'light' | 'dark';
export function currentTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
TS
echo "Le thème suit la préférence du système (clair ou sombre). Pas encore de bouton pour forcer un thème." > "$WORK/julie-repo/docs/theme.md"
echo "STRIPE_SECRET=sk_live_this_must_never_leave" > "$WORK/julie-repo/.env"
cat > "$WORK/repo-answer.json" <<CFG
{ "repoPath": "$WORK/julie-repo", "provider": { "baseUrl": "https://openrouter.ai/api/v1", "model": "nvidia/nemotron-3-super-120b-a12b:free", "apiKeyEnv": "OPENROUTER_API_KEY" } }
CFG

step "Init three nodes"
DROP_HOME="$WORK/vps" $DROP init --profile legacy --name VPS --kind machine --relay ws://127.0.0.1:7790/v1 --port 7791
DROP_HOME="$WORK/mac" $DROP init --profile legacy --name Guillaume --kind human --relay ws://127.0.0.1:7790/v1 --port 7792
DROP_HOME="$WORK/julie" $DROP init --profile legacy --name Julie --kind human --relay ws://127.0.0.1:7790/v1 --port 7793
node_id() { node -e "console.log(JSON.parse(require('fs').readFileSync('$1/identity.json','utf8')).nodeId)"; }
VPS_ID="$(node_id "$WORK/vps")"; MAC_ID="$(node_id "$WORK/mac")"; JULIE_ID="$(node_id "$WORK/julie")"

step "Relay allowing the three nodes"
printf '{ "port": 7790, "allowedNodeIds": ["%s", "%s", "%s"] }\n' "$VPS_ID" "$MAC_ID" "$JULIE_ID" > "$WORK/relay.config.json"
$RELAY serve --config="$WORK/relay.config.json" > "$WORK/relay.log" 2>&1 & PIDS+=($!)
sleep 1

step "VPS publishes production.error_summary, approved by Guillaume"
DROP_HOME="$WORK/vps" $DROP publish production.error_summary --approver "$MAC_ID" --config "$WORK/error-summary.json"

step "Julie publishes repo.answer on her repo, approved by herself"
DROP_HOME="$WORK/julie" $DROP publish repo.answer --approver "$JULIE_ID" --config "$WORK/repo-answer.json"

step "Start the three daemons (only Julie's has an LLM key)"
if [[ "$OFFLINE" -eq 1 ]]; then
  OPENROUTER_API_KEY=""
else
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
fi
DROP_HOME="$WORK/vps" env -u OPENROUTER_API_KEY $DROP serve > "$WORK/vps.log" 2>&1 & PIDS+=($!)
DROP_HOME="$WORK/mac" env -u OPENROUTER_API_KEY $DROP serve > "$WORK/mac.log" 2>&1 & PIDS+=($!)
DROP_HOME="$WORK/julie" OPENROUTER_API_KEY="$OPENROUTER_API_KEY" $DROP serve > "$WORK/julie.log" 2>&1 & PIDS+=($!)
sleep 2

step "Pairing: the VPS and Julie each invite, Guillaume pairs"
DROP_HOME="$WORK/mac" $DROP pair "$(DROP_HOME="$WORK/vps" $DROP invite | head -1)"
DROP_HOME="$WORK/mac" $DROP pair "$(DROP_HOME="$WORK/julie" $DROP invite | head -1)"
sleep 1
DROP_HOME="$WORK/mac" $DROP peers

step "Agent side (MCP): list_capabilities"
DROP_HOME="$WORK/mac" $PROBE list

step "Agent side (MCP): invalid input is refused locally"
DROP_HOME="$WORK/mac" $PROBE request '{"capability_id":"production.error_summary","input":{"service":"api","window":"3d"},"purpose":"Comprendre les erreurs de paiement"}' || true

step "Agent side (MCP): request_drop"
OUT="$(DROP_HOME="$WORK/mac" $PROBE request '{"capability_id":"production.error_summary","input":{"service":"api","window":"1h"},"purpose":"Comprendre les erreurs de paiement de ce matin"}')"
echo "$OUT"
DROP_ID="$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).drop_id))")"
sleep 1

step "Owner side: pending request (also visible in the consent UI, see $WORK/mac.log)"
DROP_HOME="$WORK/mac" $DROP pending

step "Owner approves once"
DROP_HOME="$WORK/mac" $DROP approve "$DROP_ID"

step "Agent side (MCP): get_drop_result"
DROP_HOME="$WORK/mac" $PROBE result "$DROP_ID"

step "Receipts (hashes only)"
sleep 1
DROP_HOME="$WORK/vps" $DROP receipts
DROP_HOME="$WORK/mac" $DROP receipts

step "Leak check: no log fragment in what the requester received"
if grep -R -E "alice@example|sk-ant-|9f1c2b7e|10\.0\.0\.7|42\.00" "$WORK/mac" >/dev/null 2>&1; then echo "LEAK FOUND"; exit 1; else echo "no leak"; fi

if [[ "$OFFLINE" -eq 1 ]] || [[ -z "$OPENROUTER_API_KEY" ]]; then
  step "Offline demo complete: consent, deterministic answer, receipts and leak check passed"
  echo "No model endpoint was called. The repo.answer LLM scenario requires explicit OPENROUTER_API_KEY."
  exit 0
fi

step "Agent side (MCP): ask Julie's repo a question"
OUT="$(DROP_HOME="$WORK/mac" $PROBE request '{"capability_id":"repo.answer","input":{"question":"Est-ce que l implementation de Julie gere deja le mode sombre ?"},"purpose":"Savoir si je dois coder le mode sombre ou réutiliser le sien"}')"
echo "$OUT"
DROP_ID="$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).drop_id))")"
sleep 1

step "Julie: pending request, then she allows once"
DROP_HOME="$WORK/julie" $DROP pending
DROP_HOME="$WORK/julie" $DROP approve "$DROP_ID"

step "Julie: the answer comes back to her first (high sensitivity)"
for i in $(seq 1 60); do
  PENDING="$(DROP_HOME="$WORK/julie" $DROP pending)"
  if echo "$PENDING" | grep -q "à relire"; then break; fi
  sleep 2
done
echo "$PENDING"
DROP_HOME="$WORK/julie" $DROP review "$DROP_ID" send

step "Agent side (MCP): get_drop_result"
DROP_HOME="$WORK/mac" $PROBE result "$DROP_ID"

step "Julie's receipts (she paid; cost in USD)"
sleep 1
DROP_HOME="$WORK/julie" $DROP receipts

step "Leak check: Julie's .env never reached Guillaume"
if grep -R "sk_live_this_must_never_leave" "$WORK/mac" >/dev/null 2>&1; then echo "LEAK FOUND"; exit 1; else echo "no leak"; fi
