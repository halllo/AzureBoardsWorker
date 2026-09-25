---
name: azure-repos-pr
description: Create, inspect and discuss Azure DevOps pull requests with az repos / az devops invoke (bash). PR creation with a linked work item, PR status, comment threads, replies and thread status.
---

# Azure Repos pull requests via `az`

`az repos pr` covers create/show/list/update. It has **no thread commands**, so comment threads go through `az devops invoke` against the Git REST API (`--area git`). Always quote `project="$AZDO_PROJECT"`.

## Create a PR (worker)

```bash
branch=$(git rev-parse --abbrev-ref HEAD)
target=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); target=${target:-main}
git status --porcelain   # must be empty: commit first
git push -u origin "$branch"
az repos pr create -o json \
  --repository "<repo>" --source-branch "$branch" --target-branch "$target" \
  --title "#$ABW_WORK_ITEM_ID: <summary>" \
  --description "<what changed, why, how it was verified>" \
  --work-items "$ABW_WORK_ITEM_ID" \
| jq '{pullRequestId, status, url: (.repository.webUrl + "/pullrequest/" + (.pullRequestId|tostring))}'
```

- `--description` accepts markdown. Multiple lines need separate arguments: `--description "line 1" "line 2"`.
- If a PR already exists for the branch, `create` fails. Find it with `az repos pr list --repository "<repo>" --source-branch "$branch" --status active -o json | jq '.[0].pullRequestId'`.
- The repo name comes from the origin URL: `basename -s .git "$(git remote get-url origin)"`.

## PR status (manager)

```bash
az repos pr show --id <prId> -o json | jq '{status, mergeStatus, isDraft, repoId: .repository.id, repo: .repository.name, source: .sourceRefName, target: .targetRefName}'
```
`status`: `active` | `completed` (merged) | `abandoned`.

## List comment threads

```bash
repoId=$(az repos pr show --id <prId> --query repository.id -o tsv)
az devops invoke --area git --resource pullRequestThreads --api-version 7.1 -o json \
  --route-parameters project="$AZDO_PROJECT" repositoryId="$repoId" pullRequestId=<prId> \
| jq '[.value[]
       | select(.isDeleted | not)
       | select((.properties["CodeReviewThreadType"] // null) == null)   # skip system threads (votes, pushes, policy)
       | select(.comments[0].commentType != "system")
       | {id, status, file: .threadContext.filePath, line: .threadContext.rightFileStart.line,
          comments: [.comments[] | select(.isDeleted | not) | {id, by: .author.uniqueName, text: .content}]}]'
```
A thread needs attention when `status` is `active` (or null) and the last comment's `by` is not `$ABW_IDENTITY`.

## Reply to a thread (worker)

`az devops invoke` reads the request body from a file:
```bash
body=$(mktemp); jq -n --arg c "<reply text>" '{content: $c, parentCommentId: 1, commentType: 1}' > "$body"
az devops invoke --area git --resource pullRequestThreadComments --api-version 7.1 --http-method POST --in-file "$body" -o json \
  --route-parameters project="$AZDO_PROJECT" repositoryId="$repoId" pullRequestId=<prId> threadId=<threadId> >/dev/null
rm -f "$body"
```

## Set thread status (worker)

Use `fixed` after a code change and `closed`/`wontFix` when no change was made. Use `pending` while waiting for the reviewer.
```bash
body=$(mktemp); echo '{"status":"fixed"}' > "$body"
az devops invoke --area git --resource pullRequestThreads --api-version 7.1 --http-method PATCH --in-file "$body" -o json \
  --route-parameters project="$AZDO_PROJECT" repositoryId="$repoId" pullRequestId=<prId> threadId=<threadId> >/dev/null
rm -f "$body"
```

## Gotchas
- `az devops invoke` prints warnings to stderr. Use `-o json` and parse stdout only.
- Every agent comment is authored by `$ABW_IDENTITY`. That is how the manager avoids reacting to its own replies.
