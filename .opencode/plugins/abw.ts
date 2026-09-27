// Azure Boards Worker custom tools, registered as an opencode v2 plugin.
// v2 no longer scans .opencode/tool/, and the v1 `tool()` helper with zod args
// does not load, so the tools are registered here via ctx.tool.transform.
// Runtime imports must be Node built-ins or project files: v2 installs no deps.
import type { Plugin } from "@opencode/plugin"
import { launchWorker, readExitCode, tail, waitForSessionId } from "../../src/lib/spawn.ts"
import { busyItem, isAlive, mutateState, readState, STATUSES, upsertItem } from "../../src/lib/state.ts"

const PROMPTS = {
  implement: (id: number, extra: string) =>
    `Implement Azure DevOps work item #${id} in this worktree and open a pull request for it. ` +
    `Follow your worker instructions. ${extra}`.trim(),
  feedback: (id: number, extra: string) =>
    `New review feedback arrived on the pull request for work item #${id}. ` +
    `Address each of these PR threads, push, and reply on each thread:\n\n${extra}`,
}

export default {
  id: "abw.tools",

  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      // --- state -------------------------------------------------------------
      tools.add({
        name: "state_get",
        description:
          "Read the Azure Boards Worker state: every tracked work item (status, repo, branch, worktree, PR id, worker PID/session, seen PR thread ids) and the next wake interval.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        async execute() {
          return { content: JSON.stringify(await readState(), null, 2) }
        },
      })

      tools.add({
        name: "state_update",
        description:
          "Create or patch the tracked state of one work item. Only the given fields change; seenThreadIds are merged, not replaced.",
        input: {
          type: "object",
          properties: {
            id: { type: "number", description: "Work item id" },
            title: { type: "string" },
            status: { type: "string", enum: [...STATUSES] },
            repo: { type: "string", description: "Azure Repos repository name" },
            branch: { type: "string" },
            worktree: { type: "string", description: "Absolute worktree path" },
            prId: { type: "number" },
            seenThreadIds: {
              type: "array",
              items: { type: "number" },
              description: "PR thread ids that were handled",
            },
            lastError: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(raw) {
          const { id, ...patch } = raw as { id: number } & Record<string, unknown>
          const state = await mutateState((s) => void upsertItem(s, id, patch as never))
          return { content: JSON.stringify(state.items[id], null, 2) }
        },
      })

      tools.add({
        name: "state_setWake",
        description: "Set how many seconds the outer loop sleeps before the next manager tick.",
        input: {
          type: "object",
          properties: { seconds: { type: "number", minimum: 60, maximum: 3600 } },
          required: ["seconds"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(raw) {
          const { seconds } = raw as { seconds: number }
          await mutateState((s) => void (s.nextWakeSeconds = seconds))
          return { content: `next tick in ${seconds}s` }
        },
      })

      // --- worker process ----------------------------------------------------
      tools.add({
        name: "worker_start",
        description:
          "Start the coding worker (a detached opencode session) for a work item. Requires worktree set via state_update. " +
          "Only one worker may run at a time. Mode 'feedback' continues the item's previous worker session.",
        input: {
          type: "object",
          properties: {
            id: { type: "number", description: "Work item id" },
            mode: { type: "string", enum: ["implement", "feedback"] },
            instructions: {
              type: "string",
              description:
                "implement: optional extra context. feedback: the PR thread ids and comment texts to address.",
            },
          },
          required: ["id", "mode", "instructions"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(raw) {
          const { id, mode, instructions } = raw as {
            id: number
            mode: "implement" | "feedback"
            instructions: string
          }
          const state = await readState()
          const item = state.items[id]
          if (!item?.worktree) throw new Error(`work item ${id} has no worktree in state; prepare it first`)
          const busy = busyItem(state)
          if (busy) throw new Error(`worker already busy with #${busy.id} (pid ${busy.workerPid})`)

          const proc = await launchWorker({
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
          return {
            content: `worker started for #${id}: pid ${proc.pid}, session ${sessionId ?? "unknown yet"}, log ${proc.logFile}`,
          }
        },
      })

      tools.add({
        name: "worker_status",
        description:
          "Check the worker of a work item: whether it is still running, its exit code, and the tail of its log.",
        input: {
          type: "object",
          properties: {
            id: { type: "number", description: "Work item id" },
            lines: { type: "number", description: "Log tail lines (default 15)" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(raw) {
          const { id, lines } = raw as { id: number; lines?: number }
          const item = (await readState()).items[id]
          if (!item?.workerPid) return { content: `no worker recorded for #${id}` }
          return {
            content: JSON.stringify(
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
            ),
          }
        },
      })

      // --- worker -> manager report -----------------------------------------
      tools.add({
        name: "work_report",
        description:
          "Report the result of your work on the work item back to the manager. Call exactly once, as your final step.",
        input: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: ["pr_open", "failed"],
              description:
                "pr_open: the PR exists and is up to date with your changes. failed: you could not complete the work.",
            },
            prId: { type: "number", description: "Pull request id (required for pr_open)" },
            summary: { type: "string", description: "What you did, or why it failed" },
            handledThreadIds: {
              type: "array",
              items: { type: "number" },
              description: "PR thread ids you addressed",
            },
          },
          required: ["outcome", "summary"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(raw) {
          const { outcome, prId, summary, handledThreadIds } = raw as {
            outcome: "pr_open" | "failed"
            prId?: number
            summary: string
            handledThreadIds?: number[]
          }
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
          return { content: `reported ${outcome} for #${id}` }
        },
      })
    })
  },
} satisfies Plugin.Plugin
