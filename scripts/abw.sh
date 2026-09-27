#!/usr/bin/env bash
# Outer loop of the Azure Boards Worker: run one manager tick, sleep as the manager asked, repeat.
# Usage: scripts/abw.sh          run forever
#        scripts/abw.sh --once   run a single tick (for testing)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${AZDO_ORG:?set AZDO_ORG in .env}" "${AZDO_PROJECT:?set AZDO_PROJECT in .env}" "${AZDO_TEAM:?set AZDO_TEAM in .env}"
: "${ABW_IDENTITY:?set ABW_IDENTITY in .env}"

# --- Model provider ----------------------------------------------------------
# ABW_PROVIDER picks the LLM backend: "openai" (default) or "bedrock".
# Per-model overrides in .env always win over the defaults below.
# opencode.json reads these three via {env:...}, and the agent files carry no
# `model:` of their own, so this is the single place models are decided.
ABW_PROVIDER="${ABW_PROVIDER:-openai}"
case "$ABW_PROVIDER" in
  openai)
    : "${OPENAI_API_KEY:?ABW_PROVIDER=openai needs OPENAI_API_KEY in .env}"
    export ABW_MANAGER_MODEL="${ABW_MANAGER_MODEL:-openai/gpt-5.6-terra}"
    export ABW_WORKER_MODEL="${ABW_WORKER_MODEL:-openai/gpt-5.6-sol}"
    export ABW_SMALL_MODEL="${ABW_SMALL_MODEL:-openai/gpt-5.6-luna}"
    ;;
  bedrock)
    # Bedrock auth is any one of: AWS_PROFILE, static keys, or a bearer token.
    if [[ -z "${AWS_PROFILE:-}" && -z "${AWS_ACCESS_KEY_ID:-}" && -z "${AWS_BEARER_TOKEN_BEDROCK:-}" ]]; then
      echo "ABW_PROVIDER=bedrock needs AWS_PROFILE, AWS_ACCESS_KEY_ID, or AWS_BEARER_TOKEN_BEDROCK in .env" >&2
      exit 1
    fi
    # opencode.json substitutes {env:AWS_REGION}, and an unset var becomes an
    # empty string that would override a working default - so always set it.
    export AWS_REGION="${AWS_REGION:-eu-central-1}"
    export ABW_MANAGER_MODEL="${ABW_MANAGER_MODEL:-amazon-bedrock/eu.anthropic.claude-sonnet-5}"
    export ABW_WORKER_MODEL="${ABW_WORKER_MODEL:-amazon-bedrock/eu.anthropic.claude-opus-5}"
    export ABW_SMALL_MODEL="${ABW_SMALL_MODEL:-amazon-bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0}"
    ;;
  *)
    echo "ABW_PROVIDER must be 'openai' or 'bedrock', got '$ABW_PROVIDER'" >&2
    exit 1
    ;;
esac

export ABW_HOME="${ABW_HOME:-$HOME/.abw}"
export OPENCODE_CONFIG_DIR="$ROOT/.opencode"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1   # only the skills in .opencode/skills

az devops configure --defaults organization="$AZDO_ORG" project="$AZDO_PROJECT" >/dev/null

mkdir -p logs state
echo "provider=$ABW_PROVIDER manager=$ABW_MANAGER_MODEL worker=$ABW_WORKER_MODEL" >> logs/manager.log
while true; do
  echo "=== tick $(date -u +%FT%TZ) ===" >> logs/manager.log
  # No --dir: opencode v2 removed it from `run` (the cwd is used instead, and we
  # already `cd "$ROOT"` above). Passing it makes v2 print help and do nothing.
  opencode run --agent manager --auto --title "ABW tick $(date +%F_%H%M)" \
    --model "$ABW_MANAGER_MODEL" \
    "Run one tick." >> logs/manager.log 2>&1 \
    || echo "manager tick failed with exit $?" >> logs/manager.log

  [[ "${1:-}" == "--once" ]] && break
  wake=$(jq -r '.nextWakeSeconds // 3600' state/state.json 2>/dev/null || echo 3600)
  echo "sleeping ${wake}s" >> logs/manager.log
  sleep "$wake"
done
