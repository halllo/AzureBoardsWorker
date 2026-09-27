import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { parseSessionId, readExitCode, tail } from "../src/lib/spawn.ts"

describe("parseSessionId", () => {
  it("finds the session id in opencode JSON events", () => {
    const log = [
      "some warning on stderr",
      JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_abc123", part: { sessionID: "ses_abc123" } }),
      JSON.stringify({ type: "text", sessionID: "ses_abc123" }),
    ].join("\n")
    expect(parseSessionId(log)).toBe("ses_abc123")
  })

  it("returns undefined when no event has arrived yet", () => {
    expect(parseSessionId("")).toBeUndefined()
  })
})

describe("readExitCode / tail", () => {
  it("reads the exit code written by the wrapper and tails logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abw-"))
    await writeFile(join(dir, "x.exit"), "0\n")
    await writeFile(join(dir, "x.jsonl"), "a\nb\nc\n")
    expect(readExitCode(join(dir, "x.exit"))).toBe(0)
    expect(readExitCode(join(dir, "missing.exit"))).toBeUndefined()
    expect(tail(join(dir, "x.jsonl"), 2)).toBe("b\nc")
  })
})

describe("launchWorker", () => {
  it("records the wrapper pid and exit code, and passes the prompt through verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abw-"))
    process.env.ABW_LOG_DIR = dir
    vi.resetModules()
    const { launchWorker, readExitCode } = await import("../src/lib/spawn.ts")
    const prompt = `Address thread 31: "also add modulo" it's\nmultiline & <odd>`
    const proc = await launchWorker({ id: 7, worktree: dir, prompt }, "echo")
    expect(proc.pid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(readExitCode(proc.exitFile)).toBe(0), { timeout: 10_000 })
    expect(await readFile(proc.logFile, "utf8")).toContain(prompt)
  })
})
