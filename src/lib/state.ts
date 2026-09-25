import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const STATE_DIR = process.env.ABW_STATE_DIR ?? join(ROOT, "state")
export const LOG_DIR = process.env.ABW_LOG_DIR ?? join(ROOT, "logs")

export const STATUSES = [
  "queued",
  "implementing",
  "pr_open",
  "addressing_feedback",
  "done",
  "failed",
] as const
export type Status = (typeof STATUSES)[number]
export const BUSY: readonly Status[] = ["implementing", "addressing_feedback"]

export type Item = {
  id: number
  title?: string
  status: Status
  repo?: string
  branch?: string
  worktree?: string
  prId?: number
  workerPid?: number
  workerSessionId?: string
  workerLog?: string
  workerExitFile?: string
  seenThreadIds: number[]
  summary?: string
  lastError?: string
  updatedAt: string
}

export type State = {
  items: Record<string, Item>
  nextWakeSeconds: number
}

const statePath = (dir: string) => join(dir, "state.json")

export async function readState(dir = STATE_DIR): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath(dir), "utf8")) as State
  } catch (e: any) {
    if (e.code === "ENOENT") return { items: {}, nextWakeSeconds: 3600 }
    throw e
  }
}

async function writeState(state: State, dir: string) {
  const tmp = `${statePath(dir)}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n")
  await rename(tmp, statePath(dir))
}

// mkdir is atomic, so it doubles as a cross-process lock between manager and workers.
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true })
  const lock = join(dir, "state.lock")
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock)
      break
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e
      if (i > 100) await rm(lock, { recursive: true, force: true }) // stale lock after ~10s
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export async function mutateState(fn: (s: State) => void, dir = STATE_DIR): Promise<State> {
  return withLock(dir, async () => {
    const state = await readState(dir)
    fn(state)
    await writeState(state, dir)
    return state
  })
}

export function isAlive(pid?: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The item currently holding the single worker slot, if any. */
export function busyItem(state: State, alive = isAlive): Item | undefined {
  return Object.values(state.items).find((i) => BUSY.includes(i.status) && alive(i.workerPid))
}

export function upsertItem(state: State, id: number, patch: Partial<Omit<Item, "id">>): Item {
  const current = state.items[id] ?? { id, status: "queued", seenThreadIds: [], updatedAt: "" }
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`invalid status: ${patch.status}`)
  const next: Item = {
    ...current,
    ...patch,
    id,
    seenThreadIds: [...new Set([...current.seenThreadIds, ...(patch.seenThreadIds ?? [])])],
    updatedAt: new Date().toISOString(),
  }
  state.items[id] = next
  return next
}
