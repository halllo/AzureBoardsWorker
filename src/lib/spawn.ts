import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
 * A generated sh wrapper records its own PID and the exit code, which a detached child
 * can't report otherwise.
 */
export async function launchWorker(w: WorkerLaunch, launcher = "opencode"): Promise<WorkerProcess> {
  mkdirSync(LOG_DIR, { recursive: true })
  const base = join(LOG_DIR, `worker-${Date.now()}-${w.id}`)
  const logFile = `${base}.jsonl`
  const exitFile = `${base}.exit`
  const pidFile = `${base}.pid`
  const scriptFile = `${base}.sh`
  // No --dir: opencode v2 removed it from `run`. The wrapper cds into the worktree,
  // which is what v2 uses.
  // --standalone is required: without it `run` attaches to the shared background
  // service, which was started elsewhere and does not know this project's agents
  // or plugin tools, so the worker dies with `Agent not found: "worker"`.
  const args = ["run", "--standalone", "--agent", "worker", "--format", "json", "--auto"]
  if (w.sessionId) args.push("--session", w.sessionId)
  if (w.model) args.push("--model", w.model)
  args.push("--title", `ABW #${w.id}`, w.prompt)

  writeFileSync(scriptFile, workerScript({ worktree: w.worktree, logFile, exitFile, pidFile, command: [launcher, ...args] }))
  const env = {
    ...process.env,
    ABW_WORK_ITEM_ID: String(w.id),
    OPENCODE_CONFIG_DIR: join(ROOT, ".opencode"),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
  if (process.platform === "win32") {
    // opencode v2 runs `taskkill /T /F` on its own process tree when `run` exits, which
    // killed a directly spawned wrapper after every manager tick (Node's `detached` does
    // not help). `start /b` launches sh and lets cmd exit at once, so sh has no living
    // parent in that tree. The prompt stays in the script file, away from cmd's quoting.
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `"start "" /b sh "${scriptFile}""`], {
      cwd: w.worktree,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    })
    child.unref()
  } else {
    const child = spawn("sh", [scriptFile], { cwd: w.worktree, detached: true, stdio: "ignore", env })
    child.unref()
  }
  const pid = await waitForPid(pidFile)
  if (!pid) throw new Error(`failed to spawn worker (no pid in ${pidFile})`)
  return { pid, logFile, exitFile }
}

/** The sh wrapper: records its OS pid (the Windows pid under MSYS/Git Bash), runs the worker, records its exit code. */
export function workerScript(o: { worktree: string; logFile: string; exitFile: string; pidFile: string; command: string[] }): string {
  return [
    `cd ${shQuote(o.worktree)} || exit 1`,
    `if [ -r /proc/$$/winpid ]; then cat /proc/$$/winpid; else echo $$; fi > ${shQuote(o.pidFile)}`,
    `${o.command.map(shQuote).join(" ")} < /dev/null >> ${shQuote(o.logFile)} 2>&1`,
    `echo $? > ${shQuote(o.exitFile)}`,
    "",
  ].join("\n")
}

/** Single-quotes for sh; backslashes become slashes so MSYS reads Windows paths reliably. */
function shQuote(s: string): string {
  const v = /^[A-Za-z]:\\/.test(s) ? s.replace(/\\/g, "/") : s
  return `'${v.replace(/'/g, `'\\''`)}'`
}

async function waitForPid(pidFile: string, timeoutMs = 15_000): Promise<number | undefined> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const pid = Number(readSafe(pidFile).trim())
    if (pid > 0) return pid
    await new Promise((r) => setTimeout(r, 100))
  }
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
