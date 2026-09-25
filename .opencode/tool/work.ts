import { tool } from "@opencode-ai/plugin"
import { mutateState, upsertItem } from "../../src/lib/state.ts"

export const report = tool({
  description:
    "Report the result of your work on the work item back to the manager. Call exactly once, as your final step.",
  args: {
    outcome: tool.schema
      .enum(["pr_open", "failed"])
      .describe("pr_open: the PR exists and is up to date with your changes. failed: you could not complete the work."),
    prId: tool.schema.number().optional().describe("Pull request id (required for pr_open)"),
    summary: tool.schema.string().describe("What you did, or why it failed"),
    handledThreadIds: tool.schema.array(tool.schema.number()).optional().describe("PR thread ids you addressed"),
  },
  async execute({ outcome, prId, summary, handledThreadIds }) {
    const id = Number(process.env.ABW_WORK_ITEM_ID)
    if (!id) throw new Error("ABW_WORK_ITEM_ID is not set; work_report only works inside a worker session")
    if (outcome === "pr_open" && !prId) throw new Error("prId is required when outcome is pr_open")
    await mutateState((s) =>
      upsertItem(s, id, {
        status: outcome,
        ...(prId ? { prId } : {}),
        summary,
        seenThreadIds: handledThreadIds,
        lastError: outcome === "failed" ? summary : undefined,
      }),
    )
    return `reported ${outcome} for #${id}`
  },
})
