#!/usr/bin/env bash
# Outer loop of the Azure Boards Worker: run one manager tick, sleep as the manager asked, repeat.
# Usage: scripts/abw.sh                    run forever (manager-selected sleep; 3600-second fallback)
#        scripts/abw.sh --once             run a single tick (for testing)
#        scripts/abw.sh --sleep <seconds>  override the manager's wake interval
set -uo pipefail

sleep_override=""
once=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)
      once=true
      ;;
    --sleep)
      [[ $# -ge 2 ]] || { echo "--sleep requires a duration in seconds" >&2; exit 2; }
      sleep_override="$2"
      shift
      ;;
    *)
      echo "usage: scripts/abw.sh [--once] [--sleep <seconds>]" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -z "$sleep_override" || "$sleep_override" =~ ^[0-9]+$ ]] || { echo "--sleep must be a non-negative whole number of seconds" >&2; exit 2; }

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
# The Azure DevOps extension prefers a valid `az login` account over its token
# environment variable. Keep this worker's Azure CLI state separate so it uses
# the refreshed Entra agent token instead of the developer's cached identity.
export AZURE_CONFIG_DIR="$ABW_HOME/azure-cli"
export AZURE_EXTENSION_DIR="${AZURE_EXTENSION_DIR:-$HOME/.azure/cliextensions}"
export OPENCODE_CONFIG_DIR="$ROOT/.opencode"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1   # only the skills in .opencode/skills

refresh_devops_token() {
  [[ "${ABW_AUTH:-pat}" == "entra-agent" ]] || return
  : "${ENTRA_TENANT_ID:?ABW_AUTH=entra-agent needs ENTRA_TENANT_ID in .env}"
  : "${ENTRA_AGENT_IDENTITY:?ABW_AUTH=entra-agent needs ENTRA_AGENT_IDENTITY in .env}"
  : "${ENTRA_AGENT_USER_ID:?ABW_AUTH=entra-agent needs ENTRA_AGENT_USER_ID in .env}"
  : "${ENTRA_AGENT_BLUEPRINT_ID:?ABW_AUTH=entra-agent needs ENTRA_AGENT_BLUEPRINT_ID in .env}"
  : "${ENTRA_AGENT_BLUEPRINT_SECRET:?ABW_AUTH=entra-agent needs ENTRA_AGENT_BLUEPRINT_SECRET in .env}"

  local dotnet_command
  if command -v dotnet >/dev/null 2>&1; then
    dotnet_command="$(command -v dotnet)"
  elif command -v dotnet.exe >/dev/null 2>&1; then
    dotnet_command="$(command -v dotnet.exe)"
  elif [[ -x "/mnt/c/Program Files/dotnet/dotnet.exe" ]]; then
    dotnet_command="/mnt/c/Program Files/dotnet/dotnet.exe"
  elif [[ -x "/c/Program Files/dotnet/dotnet.exe" ]]; then
    dotnet_command="/c/Program Files/dotnet/dotnet.exe"
  else
    echo "dotnet SDK not found; install .NET 10 or add dotnet to PATH" >&2
    return 1
  fi

  local token
  if ! token="$("$dotnet_command" run --verbosity quiet "$ROOT/scripts/entra-token.cs" --no-launch-profile)"; then
    echo "failed to acquire Azure DevOps token for the Entra agent identity" >&2
    return 1
  fi
  [[ -n "$token" ]] || { echo "Entra token helper returned an empty token" >&2; return 1; }
  export AZURE_DEVOPS_EXT_PAT="$token"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.https://dev.azure.com/.extraheader"
  export GIT_CONFIG_VALUE_0="Authorization: Bearer $token"
}

refresh_devops_token || exit 1
az devops configure --defaults organization="$AZDO_ORG" project="$AZDO_PROJECT" >/dev/null

mkdir -p logs state
while true; do
  tick_started_at="$(date -u +%Y%m%dT%H%M%SZ)"
  manager_log="logs/manager-${tick_started_at}-$$.log"
  echo "provider=$ABW_PROVIDER manager=$ABW_MANAGER_MODEL worker=$ABW_WORKER_MODEL" > "$manager_log"
  echo "=== tick $(date -u +%FT%TZ) ===" >> "$manager_log"
  refresh_devops_token || { echo "token refresh failed; manager tick skipped" >> "$manager_log"; $once && break; sleep 60; continue; }
  # No --dir: opencode v2 removed it from `run` (the cwd is used instead, and we
  # already `cd "$ROOT"` above). Passing it makes v2 print help and do nothing.
  # --standalone: without it `run` attaches to the shared background service,
  #   which may have been started elsewhere and not know this project's agents
  #   or plugin tools (symptom: `Agent not found: "manager"`).
  # < /dev/null: opencode reads stdin when it is not a terminal and waits
  #   forever on an open pipe (symptom: nothing after the `cli starting` log).
  opencode run --standalone --agent manager --auto --title "ABW tick $(date +%F_%H%M)" \
    --model "$ABW_MANAGER_MODEL" \
    "Run one tick." < /dev/null >> "$manager_log" 2>&1 \
    || echo "manager tick failed with exit $?" >> "$manager_log"

  $once && break
  wake="${sleep_override:-$(jq -r '.nextWakeSeconds // 3600' state/state.json 2>/dev/null || echo 3600)}"
  echo "sleeping ${wake}s" >> "$manager_log"
  sleep "$wake"
done
