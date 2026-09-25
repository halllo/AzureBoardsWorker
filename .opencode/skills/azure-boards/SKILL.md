---
name: azure-boards
description: Query and update Azure DevOps work items with the az boards CLI (bash). Sprint queries for @Me, reading fields, state changes, discussion comments.
---

# Azure Boards via `az boards`

Defaults (`organization`, `project`) come from `az devops configure --defaults` or the `$AZDO_ORG` / `$AZDO_PROJECT` env vars. Pass `--org "$AZDO_ORG" --project "$AZDO_PROJECT"` explicitly if the defaults are not set. Always quote project names that contain spaces.

## Current sprint items assigned to me

`@CurrentIteration` needs the team: `@CurrentIteration('[Project]\Team')`.

```bash
az boards query -o json --wiql "
SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],
       [Microsoft.VSTS.Common.Priority], [System.Tags], [System.ChangedDate]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
  AND [System.IterationPath] = @CurrentIteration('[$AZDO_PROJECT]\\$AZDO_TEAM')
  AND [System.State] NOT IN ('Done', 'Closed', 'Removed', 'Resolved')
ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC" \
| jq '[.[] | {id, title: .fields["System.Title"], state: .fields["System.State"], type: .fields["System.WorkItemType"], priority: .fields["Microsoft.VSTS.Common.Priority"], tags: .fields["System.Tags"], changed: .fields["System.ChangedDate"]}]'
```

If `@CurrentIteration` fails, look up the path with `az boards iteration team list --team "$AZDO_TEAM" --timeframe current -o json | jq -r '.[0].path'` and compare with `[System.IterationPath] = '<path>'`.

## Read a work item

```bash
az boards work-item show --id <id> --expand relations -o json \
| jq '{id, type: .fields["System.WorkItemType"], state: .fields["System.State"], title: .fields["System.Title"],
       description: .fields["System.Description"], acceptance: .fields["Microsoft.VSTS.Common.AcceptanceCriteria"],
       repro: .fields["Microsoft.VSTS.TCM.ReproSteps"], tags: .fields["System.Tags"],
       relations: [.relations[]? | {rel, url, name: .attributes.name}]}'
```

Description, acceptance criteria and repro steps are HTML. Read them for their content and ignore the markup.

Discussion comments (these are not included in `show`):
```bash
az devops invoke --area wit --resource comments --api-version 7.1-preview \
  --route-parameters project="$AZDO_PROJECT" workItemId=<id> -o json \
| jq '[.comments[] | {by: .createdBy.displayName, at: .createdDate, text}]'
```

Linked PRs show up in `relations` as `rel: "ArtifactLink"` with `vstfs:///Git/PullRequestId/...` URLs.

## Change state and comment

```bash
az boards work-item update --id <id> --state Active --discussion "🤖 Picked up by Azure Boards Worker."
az boards work-item update --id <id> --state Done   --discussion "🤖 PR !<prId> merged."
```

Valid states depend on the process template (Scrum: `New/Approved/Committed/Done`, Agile: `New/Active/Resolved/Closed`, Basic: `To Do/Doing/Done`). If an update is rejected for an invalid state, try the equivalent state from the list above (for example `Closed` instead of `Done`).

Comment only: `az boards work-item update --id <id> --discussion "<text>"`. `--discussion` accepts HTML.

## Identity
The agent's own identity (unique name / email) is in `$ABW_IDENTITY`. It is the identity `@Me` resolves to, and it authors the agent's comments.
