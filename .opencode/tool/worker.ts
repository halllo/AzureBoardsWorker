import { tool } from "@opencode-ai/plugin"
import { launchWorker, readExitCode, tail, waitForSessionId } from "../../src/lib/spawn.ts"
import { busyItem, isAlive, mutateState, readState, upsertItem } from "../../src/lib/state.ts"

const PROMPTS = {
  implement: (id: number, extra: string) =>
    `Implement Azure DevOps work item #${id} in this worktree and open a pull request for it. ` +
    `Follow your worker instructions. ${extra}`.trim(),
  feedback: (id: number, extra: string) =>
    `New review feedback arrived on the pull request for work item #${id}. ` +
    `Address each of these PR threads, push, and reply on each thread:\n\n${extra}`,
}

export const start = tool({
  description:
    "Start the coding worker (a detached opencode session) for a work item. Requires worktree set via state_update. " +
    "Only one worker may run at a time. Mode 'feedback' continues the item's previous worker session.",
  args: {
    id: tool.schema.number(),
    mode: tool.schema.enum(["implement", "feedback"]),
    instructions: tool.schema
      .string()
      .describe("implement: optional extra context. feedback: the PR thread ids and comment texts to address."),
  },
  async execute({ id, mode, instructions }) {
    const state = await readState()
    const item = state.items[id]
    if (!item?.worktree) throw new Error(`work item ${id} has no worktree in state; prepare it first`)
    const busy = busyItem(state)
    if (busy) throw new Error(`worker already busy with #${busy.id} (pid ${busy.workerPid})`)

    const proc = launchWorker({
      id,
      worktree: item.worktree,
      prompt: PROMPTS[mode](id, instructions),
      sessionId: mode === "feedback" ? item.workerSessionId : undefined,
      model: process.env.ABW_WORKER_MODEL,
    })
    await mutateState((s) =>
      upsertItem(s, id, {
        status: mode === "implement" ? "implementing" : "addressing_feedback",
        workerPid: proc.pid,
        workerLog: proc.logFile,
        workerExitFile: proc.exitFile,
        lastError: undefined,
      }),
    )
    const sessionId = (await waitForSessionId(proc.logFile)) ?? item.workerSessionId
    if (sessionId) await mutateState((s) => void upsertItem(s, id, { workerSessionId: sessionId }))
    return `worker started for #${id}: pid ${proc.pid}, session ${sessionId ?? "unknown yet"}, log ${proc.logFile}`
  },
})

export const status = tool({
  description: "Check the worker of a work item: whether it is still running, its exit code, and the tail of its log.",
  args: { id: tool.schema.number(), lines: tool.schema.number().optional() },
  async execute({ id, lines }) {
    const item = (await readState()).items[id]
    if (!item?.workerPid) return `no worker recorded for #${id}`
    return JSON.stringify(
      {
        id,
        status: item.status,
        pid: item.workerPid,
        running: isAlive(item.workerPid),
        exitCode: readExitCode(item.workerExitFile) ?? null,
        sessionId: item.workerSessionId ?? null,
        summary: item.summary ?? null,
        logTail: item.workerLog ? tail(item.workerLog, lines ?? 15) : "",
      },
      null,
      2,
    )
  },
})
