import { tool } from "@opencode-ai/plugin"
import { mutateState, readState, STATUSES, upsertItem } from "../../src/lib/state.ts"

export const get = tool({
  description:
    "Read the Azure Boards Worker state: every tracked work item (status, repo, branch, worktree, PR id, worker PID/session, seen PR thread ids) and the next wake interval.",
  args: {},
  async execute() {
    return JSON.stringify(await readState(), null, 2)
  },
})

export const update = tool({
  description:
    "Create or patch the tracked state of one work item. Only the given fields change; seenThreadIds are merged, not replaced.",
  args: {
    id: tool.schema.number().describe("Work item id"),
    title: tool.schema.string().optional(),
    status: tool.schema.enum(STATUSES).optional(),
    repo: tool.schema.string().optional().describe("Azure Repos repository name"),
    branch: tool.schema.string().optional(),
    worktree: tool.schema.string().optional().describe("Absolute worktree path"),
    prId: tool.schema.number().optional(),
    seenThreadIds: tool.schema.array(tool.schema.number()).optional().describe("PR thread ids that were handled"),
    lastError: tool.schema.string().optional(),
  },
  async execute({ id, ...patch }) {
    const state = await mutateState((s) => void upsertItem(s, id, patch))
    return JSON.stringify(state.items[id], null, 2)
  },
})

export const setWake = tool({
  description: "Set how many seconds the outer loop sleeps before the next manager tick.",
  args: { seconds: tool.schema.number().int().min(60).max(3600) },
  async execute({ seconds }) {
    await mutateState((s) => void (s.nextWakeSeconds = seconds))
    return `next tick in ${seconds}s`
  },
})
