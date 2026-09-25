import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { busyItem, mutateState, readState, upsertItem, type State } from "../src/lib/state.ts"

const empty = (): State => ({ items: {}, nextWakeSeconds: 3600 })

describe("upsertItem", () => {
  it("creates a queued item with defaults", () => {
    const s = empty()
    const item = upsertItem(s, 7, { title: "x" })
    expect(item).toMatchObject({ id: 7, status: "queued", title: "x", seenThreadIds: [] })
    expect(s.items[7]).toBe(item)
  })

  it("merges seenThreadIds without duplicates", () => {
    const s = empty()
    upsertItem(s, 1, { seenThreadIds: [1, 2] })
    upsertItem(s, 1, { seenThreadIds: [2, 3] })
    expect(s.items[1].seenThreadIds).toEqual([1, 2, 3])
  })

  it("rejects unknown statuses", () => {
    expect(() => upsertItem(empty(), 1, { status: "bogus" as any })).toThrow(/invalid status/)
  })
})

describe("busyItem", () => {
  it("only counts busy items whose worker is alive", () => {
    const s = empty()
    upsertItem(s, 1, { status: "implementing", workerPid: 111 })
    upsertItem(s, 2, { status: "pr_open", workerPid: 222 })
    upsertItem(s, 3, { status: "addressing_feedback", workerPid: 333 })
    expect(busyItem(s, (pid) => pid === 333)?.id).toBe(3)
    expect(busyItem(s, (pid) => pid === 222)).toBeUndefined()
    expect(busyItem(s, () => false)).toBeUndefined()
  })
})

describe("persistence", () => {
  it("returns empty state when no file exists and writes atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abw-"))
    expect(await readState(dir)).toEqual(empty())
    await mutateState((s) => void upsertItem(s, 5, { status: "pr_open", prId: 9 }), dir)
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"))
    expect(raw.items["5"]).toMatchObject({ status: "pr_open", prId: 9 })
  })

  it("serialises concurrent mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abw-"))
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => mutateState((s) => void upsertItem(s, 1, { seenThreadIds: [i] }), dir)),
    )
    expect((await readState(dir)).items[1].seenThreadIds.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    )
  })
})
