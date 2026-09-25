---
name: abw-workspace
description: Azure Boards Worker workspace layout. How to pick the repository for a work item, mirror-clone it, create and remove the per-item git worktree, and name branches.
---

# Workspace: repos and worktrees

```
$ABW_HOME/                     (default ~/.abw)
  repos/<repo>.git             bare mirror, shared by all work items of that repo
  worktrees/<id>               one worktree per work item, on branch abw/<id>-<slug>
```

## 1. Pick the repository
Use the first rule that applies:
1. The work item has a tag `repo:<name>` (in `System.Tags`, separated by `; `). Use `<name>`.
2. The work item or its parent links a PR or commit (`ArtifactLink` relations with `vstfs:///Git/...`). Use that repo: `az repos pr show --id <linkedPrId> --query repository.name -o tsv`.
3. Otherwise `az repos list --project "$AZDO_PROJECT" -o json | jq -r '.[] | select(.isDisabled|not) | .name'` and choose the repo that the title or description clearly refers to. If more than one could fit, or none does, stop and ask on the work item. Do not guess.

Clone URL: `az repos show --repository "<repo>" --query remoteUrl -o tsv`.

## 2. Mirror clone / fetch

```bash
home=${ABW_HOME:-$HOME/.abw}; mkdir -p "$home/repos" "$home/worktrees"
mirror="$home/repos/<repo>.git"
test -d "$mirror" || git clone --bare "<remoteUrl>" "$mirror"
git -C "$mirror" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$mirror" fetch --prune origin
git -C "$mirror" remote set-head origin --auto
default=$(git -C "$mirror" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
```
Git authentication for the clone uses the same credentials as `az`. If the clone prompts or fails with 401, stop and record `lastError`.

## 3. Create the worktree

Branch: `abw/<id>-<slug>`, where the slug is the title lowercased, non-alphanumerics replaced with `-`, and cut to 40 characters.
```bash
slug=$(printf '%s' "<title>" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40 | sed -E 's/-+$//')
branch="abw/<id>-$slug"
wt="$home/worktrees/<id>"
test -d "$wt" || git -C "$mirror" worktree add -b "$branch" "$wt" "origin/$default"
git -C "$wt" config push.autoSetupRemote true
```
If the worktree already exists (from a retried item), reuse it: `git -C "$wt" status` and `git -C "$wt" rev-parse --abbrev-ref HEAD`.

Record `repo`, `branch` and `worktree` (absolute path) with `state_update`.

## 4. Clean up after merge

```bash
git -C "$mirror" worktree remove --force "$wt"
git -C "$mirror" branch -D "$branch"
git -C "$mirror" worktree prune
```
