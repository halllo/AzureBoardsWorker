// opencode v2 plugin template. Copy to .opencode/plugins/<name>.ts and edit.
// Standalone: only Node built-ins at runtime, the type import is erased, inputs are JSON Schema.
import type { Plugin } from "@opencode/plugin"
import { appendFile } from "node:fs/promises"
import path from "node:path"

export default {
  id: "team.example", // unique, stable id

  async setup(ctx) {
    const root = ctx.location.directory
    const logFile = path.join(root, ".opencode", "team-example.log")
    const log = (line: string) => appendFile(logFile, `${new Date().toISOString()} ${line}\n`).catch(() => {})

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "team_example_echo",
        description: "Echo a message back, upper-cased. Use when the user asks to shout something.",
        input: {
          type: "object",
          properties: { message: { type: "string", description: "Text to echo" } },
          required: ["message"],
          additionalProperties: false,
        },
        options: { codemode: false }, // direct tool; remove to put it in the Code Mode catalog
        async execute(raw, call) {
          const input = raw as { message: string }
          if (!input.message.trim()) throw new Error("message must not be empty")
          await log(`echo session=${call.sessionID}`)
          return { content: input.message.toUpperCase() }
        },
      })
    })

    return () => log("cleanup")
  },
} satisfies Plugin.Plugin
