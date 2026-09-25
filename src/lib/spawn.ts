import { spawn } from "node:child_process"
import { mkdirSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { LOG_DIR, ROOT } from "./state.ts"

export type WorkerLaunch = {
  id: number
  worktree: string
  prompt: string
  sessionId?: string
  model?: string
}

export type WorkerProcess = { pid: number; logFile: string; exitFile: string }

/**
 * Starts `opencode run --agent worker` fully detached, so it outlives the manager tick.
 * The shell wrapper records the exit code, which a detached child can't report otherwise.
 */
export function launchWorker(w: WorkerLaunch): WorkerProcess {
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = Date.now()
  const logFile = join(LOG_DIR, `${w.id}-${stamp}.jsonl`)
  const exitFile = join(LOG_DIR, `${w.id}-${stamp}.exit`)
  const args = ["run", "--agent", "worker", "--dir", w.worktree, "--format", "json", "--auto"]
  if (w.sessionId) args.push("--session", w.sessionId)
  if (w.model) args.push("--model", w.model)
  args.push("--title", `ABW #${w.id}`, w.prompt)

  const out = openSync(logFile, "a")
  const child = spawn("sh", ["-c", 'opencode "$@"; echo $? > "$ABW_EXIT_FILE"', "sh", ...args], {
    cwd: w.worktree,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ABW_EXIT_FILE: exitFile,
      ABW_WORK_ITEM_ID: String(w.id),
      OPENCODE_CONFIG_DIR: join(ROOT, ".opencode"),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    },
  })
  child.unref()
  if (!child.pid) throw new Error("failed to spawn worker")
  return { pid: child.pid, logFile, exitFile }
}

/** opencode's JSON events carry the session id as `sessionID` (top level or nested). */
export function parseSessionId(log: string): string | undefined {
  return log.match(/"sessionID"\s*:\s*"([^"]+)"/)?.[1]
}

export async function waitForSessionId(logFile: string, timeoutMs = 30_000): Promise<string | undefined> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const id = parseSessionId(readSafe(logFile))
    if (id) return id
    await new Promise((r) => setTimeout(r, 500))
  }
}

export function readExitCode(exitFile?: string): number | undefined {
  const raw = exitFile ? readSafe(exitFile).trim() : ""
  return raw === "" ? undefined : Number(raw)
}

export function tail(file: string, lines = 20): string {
  return readSafe(file).split("\n").filter(Boolean).slice(-lines).join("\n")
}

function readSafe(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
