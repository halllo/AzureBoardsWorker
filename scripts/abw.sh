#!/usr/bin/env bash
# Outer loop of the Azure Boards Worker: run one manager tick, sleep as the manager asked, repeat.
# Usage: scripts/abw.sh          run forever
#        scripts/abw.sh --once   run a single tick (for testing)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${AZDO_ORG:?set AZDO_ORG in .env}" "${AZDO_PROJECT:?set AZDO_PROJECT in .env}" "${AZDO_TEAM:?set AZDO_TEAM in .env}"
: "${ABW_IDENTITY:?set ABW_IDENTITY in .env}" "${AWS_REGION:?set AWS_REGION in .env}"
export ABW_HOME="${ABW_HOME:-$HOME/.abw}"
export OPENCODE_CONFIG_DIR="$ROOT/.opencode"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1   # only the skills in .opencode/skills

az devops configure --defaults organization="$AZDO_ORG" project="$AZDO_PROJECT" >/dev/null

mkdir -p logs state
while true; do
  echo "=== tick $(date -u +%FT%TZ) ===" >> logs/manager.log
  opencode run --agent manager --dir "$ROOT" --auto --title "ABW tick $(date +%F_%H%M)" \
    ${ABW_MANAGER_MODEL:+--model "$ABW_MANAGER_MODEL"} \
    "Run one tick." >> logs/manager.log 2>&1 \
    || echo "manager tick failed with exit $?" >> logs/manager.log

  [[ "${1:-}" == "--once" ]] && break
  wake=$(jq -r '.nextWakeSeconds // 3600' state/state.json 2>/dev/null || echo 3600)
  echo "sleeping ${wake}s" >> logs/manager.log
  sleep "$wake"
done
