# Azure Boards Worker

An autonomous developer for Azure DevOps. It connects with the `az` CLI using its own identity and checks the current sprint for work items assigned to it. When it finds one, it sets the item to *Active*, prepares a git worktree, and hands the item to a coding agent that implements the change and opens a PR. While the PR is open, it reacts to review comments. Once the PR is merged, it closes the work item.

The worker implements one item at a time. While a PR waits for review, the worker can start on the next item. With nothing to do, it sleeps for an hour and checks again.

## How it works

Two [opencode](https://opencode.ai) agents run on either OpenAI or AWS Bedrock models, selected by `ABW_PROVIDER` in `.env`:

| Agent | Role | Definition |
|---|---|---|
| **manager** | One *tick*: reconcile the worker, follow up on open PRs (merged → close item, new comments → feedback run), start the next sprint item, set the next wake-up | [.opencode/agent/manager.md](.opencode/agent/manager.md) |
| **worker** | Implements one item in its worktree, tests, commits, pushes, opens the PR or replies to review threads, and reports back | [.opencode/agent/worker.md](.opencode/agent/worker.md) |

[scripts/abw.sh](scripts/abw.sh) is the outer loop. It runs a manager tick, sleeps for as long as the manager asked (5 min / 15 min / 1 h), and repeats. The worker runs as a detached `opencode run` process, so a manager tick never blocks on it. Feedback runs continue the worker's previous opencode session, so the worker keeps its context.

**Azure DevOps and git go through opencode's `bash` tool** (`az boards`, `az repos`, `az devops invoke` for PR threads, and `git`). The exact commands are in skills:

- [azure-boards](.opencode/skills/azure-boards/SKILL.md): sprint query for `@Me`, reading items, state changes, comments
- [azure-repos-pr](.opencode/skills/azure-repos-pr/SKILL.md): create/show PRs, list and reply to comment threads
- [abw-workspace](.opencode/skills/abw-workspace/SKILL.md): pick the repo, mirror clone, per-item worktree, cleanup

**Custom tools** ([.opencode/plugins/abw.ts](.opencode/plugins/abw.ts), registered as an opencode v2 plugin) cover only what the CLI can't do well:

- `state_get` / `state_update` / `state_setWake`: locked, atomic `state/state.json`, the manager's memory between ticks
- `worker_start` / `worker_status`: spawn and inspect the single detached worker (PID, session id, exit code, log)
- `work_report`: the worker hands its result (PR id, handled threads, or a failure) back to the manager

Item lifecycle: `queued → implementing → pr_open ⇄ addressing_feedback → done`, or `failed`, with the reason in `lastError` and a comment on the work item.

### Workspace
```
~/.abw/repos/<repo>.git      bare mirror per repository (cloned on first use)
~/.abw/worktrees/<id>        one worktree per work item, branch abw/<id>-<slug>
state/state.json             tracked items (gitignored)
logs/manager.log             manager ticks
logs/<id>-<ts>.jsonl         worker event streams
```
The repository for an item comes from a `repo:<name>` tag. Failing that, the manager uses a linked PR, or infers it from the item text. If the repo is still ambiguous, the manager asks on the work item instead of guessing.

## Setup

1. **Prerequisites:** `opencode` (≥ 1.18), `az` with the `azure-devops` extension, `git`, `jq`, and Node 24.
2. `npm install`
3. `cp .env.example .env` and fill it in:
   - **LLM provider:** `ABW_PROVIDER=openai` (default) needs `OPENAI_API_KEY`. `ABW_PROVIDER=bedrock` needs Bedrock access via `AWS_PROFILE` (or static keys, or `AWS_BEARER_TOKEN_BEDROCK`) plus `AWS_REGION`. Never put credentials in the repo.
   - **Azure DevOps:** `AZDO_ORG`, `AZDO_PROJECT`, `AZDO_TEAM` (for `@CurrentIteration`) and `ABW_IDENTITY`, the agent account's unique name. Authenticate as that account with `az login`, or set `AZURE_DEVOPS_EXT_PAT` (scopes: Work Items R/W, Code R/W).
   - **Entra agent identity (optional):** set `ABW_AUTH=entra-agent`, `ENTRA_AGENT_IDENTITY`, `ENTRA_AGENT_USER_ID`, `ENTRA_TENANT_ID`, `ENTRA_AGENT_BLUEPRINT_ID`, and `ENTRA_AGENT_BLUEPRINT_SECRET`. The launcher exchanges the identity for an Azure DevOps token before each manager tick and exports it as `AZURE_DEVOPS_EXT_PAT` to the manager and any worker it starts. The confidential client must have the Azure DevOps delegated `user_impersonation` grant for the agent user. Keep `ENTRA_AGENT_BLUEPRINT_SECRET` in a local secret store or ignored `.env` file.
   - Git must be able to clone and push the target repos as that identity, for example with Git Credential Manager or a PAT in the credential helper.
4. Assign a work item in the current sprint to the agent account, optionally tagged `repo:<name>`.

## Run

```bash
npm run tick    # one manager tick, then exit
npm start       # run forever
tail -f logs/manager.log
```

Watch or resume a worker session interactively: `OPENCODE_CONFIG_DIR=$PWD/.opencode opencode --session <workerSessionId from state.json>`.

## Development

```bash
npm test          # state + spawn unit tests
npm run typecheck
OPENCODE_CONFIG_DIR=$PWD/.opencode opencode debug agents   # resolved tools/permissions
OPENCODE_CONFIG_DIR=$PWD/.opencode opencode debug config   # merged config sources
OPENCODE_CONFIG_DIR=$PWD/.opencode opencode models         # every resolvable provider/model
```

Model overrides: `ABW_MANAGER_MODEL`, `ABW_WORKER_MODEL`, `ABW_SMALL_MODEL`. Unset, they default per `ABW_PROVIDER` — `openai/gpt-5.6-terra` + `openai/gpt-5.6-sol` for OpenAI, `eu.anthropic.claude-sonnet-5` + `eu.anthropic.claude-opus-5` for Bedrock. [scripts/abw.sh](scripts/abw.sh) resolves them and `.opencode/opencode.json` reads them via `{env:...}`; the agent files deliberately carry no `model:` of their own, so primary agents inherit the resolved global model.
