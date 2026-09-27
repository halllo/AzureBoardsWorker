---
name: opencode-v2-plugin-tools
description: Build custom tools for opencode v2 as plugins, as standalone TypeScript files with no dependencies. Use when asked to create, add, debug or verify an opencode plugin, custom tool, tool hook or shell hook for opencode 2.x.
---

# Custom tools via opencode v2 plugins

Everything below was tested against **opencode 2.0.18**. Check the version with `opencode --version`. The v2 plugin API is new, so re-verify on other versions.

## Most important: don't use the v1 API

Most docs and examples online describe **v1**, and v1 plugins fail on v2:

| v1 (wrong on v2) | v2 (correct) |
| --- | --- |
| `export const X = async (ctx) => ({ tool: {...} })` | `export default { id, setup(ctx) }` |
| `import { tool } from "@opencode-ai/plugin"` | types from `@opencode/plugin` (type-only import) |
| `tool.schema.string()` (zod) | plain JSON Schema object |
| `.opencode/tools/*.ts` custom-tool files | not scanned in v2; register tools from a plugin |
| `plugin: [...]` in opencode.json | key is `plugins`; not needed for `.opencode/plugins/` (see Plugin options) |

## Steps

1. **Create the file.** Copy [template.ts](template.ts) to `.opencode/plugins/<name>.ts` in the project's working directory. Always put plugins in the project, never in the user's home folder.
   Every `*.ts` in that folder is loaded automatically by opencode's embedded Bun runtime. There's no build step, `package.json`, `npm install` or config entry.
2. **Set a unique `id`** (e.g. `"team.feature"`) and register tools in `ctx.tool.transform(t => t.add({...}))`. Call `t.add` once per tool inside the same callback to register several tools.
3. **Use only Node built-ins at runtime** (`node:fs/promises`, `node:child_process`, `node:path`, …) and `fetch`.
   v2 does **not** install dependencies, so `import { z } from "zod"` fails with `Cannot find package`. `import type` lines are fine because they're erased.
4. **Describe `input` with JSON Schema** (`type: "object"`, `properties`, `required`, `additionalProperties: false`).
   opencode checks arguments against it **before** `execute` runs. Bad calls go back to the model as `Invalid arguments for tool "...": - n: Expected number`, and your code never sees them.
   Tested as enforced: `type`, `required`, `minimum` and `maximum`. `pattern` is untested, so check security-relevant formats (labels, paths) in code as well.
   Mark optional fields by leaving them out of `required`, and cast them as optional (`tag?: string`). For a tool with no arguments, use `{ type: "object", properties: {} }`, and read the input defensively (`(raw ?? {}) as {...}`).
   Inside `execute`, the input is typed `unknown`, so cast it: `const input = raw as { n: number; tag?: string }`.
5. **Verify** (see below). Don't claim the tool works until a real run shows it being called.

## Tool definition reference

```ts
t.add({
  name: "team_do_thing",            // what the model calls; use a prefix to avoid clashes
  description: "What it does and when to use it. The model only sees this.",
  input: { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false },
  output: { type: "object", properties: { answer: { type: "number" } } }, // optional, for structured output
  options: { codemode: false },     // optional, see "Code Mode" below
  async execute(raw, call) {        // call: { sessionID, agent, messageID, id, signal, progress }
    const { x } = raw as { x: string }
    await call.progress({ step: "working" })   // optional live metadata
    return { content: `did ${x}`, metadata: { x } }
  },
})
```

What `execute` can return (all tested):

| Return | The model sees |
| --- | --- |
| `{ content: "text" }` | the text |
| `{ content: [{ type: "text", text }, { type: "file", uri: "data:text/plain;base64,...", mime: "text/plain", name: "a.txt" }] }` | text plus the file; the model can read the file body (tested with `text/plain` and `text/csv`) |
| `{ output: { answer: 42 } }` (with `output` schema) | `{"answer":42}`; no `content` is needed. What happens when output doesn't match the schema is untested. |
| `throw new Error("msg")` | `{"error":{"type":"unknown","message":"msg"},"content":[]}`; the session carries on |
| *(arguments fail the input schema)* | `{"error":{"type":"tool.execution",...}}` with the `Invalid arguments...` text; `execute` is not called |

In Code Mode (see below), a thrown error rejects the promise of `tools.<name>(...)` inside the model's code. When the model batches several calls in one `Promise.all`, a single error fails the whole batch and the model retries the calls one by one. Keep errors for real failures.

To report a failure to the model, **throw an `Error` with a helpful message**. It's the only error path that works without dependencies.

`metadata` is extra data for the host UI and hooks, and isn't the model's main output. Put everything the model needs in `content`.

### Code Mode vs. direct tools

- **Default:** the tool goes into v2's *Code Mode catalog*. The model runs the built-in `execute` tool, usually calls `search(...)` to find your tool, then calls `tools.<name>({...})`. If the prompt names the tool, the model may skip the search. That's extra round trips, but it keeps large toolsets out of the prompt.
- **`options: { codemode: false }`:** the tool is a regular direct tool the model can call right away. Use this for a few frequently used tools.

### Permissions

`options: { permission: "team_secret" }` gives the tool a permission key (the tool name is used when you don't set one). A matching `deny` rule in the v2 `permissions` array of `opencode.json` removes the tool completely, so the model doesn't see it. `action` is the permission key, and `"resource": "*"` matches every call:

```json
{ "permissions": [{ "action": "team_secret", "resource": "*", "effect": "deny" }] }
```

Tools run with the **user's full OS rights**, and there's no approval prompt: a custom tool ran in `opencode run` even without `--auto`. Validate paths, don't pass model input to a shell unescaped, and put destructive tools behind a permission key.

To keep a model-supplied path inside the project (tested against `../`, absolute paths, symlinks pointing outside, and names like `..notes.csv`):

```ts
import { realpath } from "node:fs/promises"
import path from "node:path"

async function resolveInProject(root: string, userPath: string): Promise<string> {
  const realRoot = await realpath(root)
  const inside = (p: string) => {
    const rel = path.relative(realRoot, p)
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  }
  const target = path.resolve(realRoot, userPath)
  if (!inside(target)) throw new Error(`Path "${userPath}" is outside the project`)
  let real: string
  try { real = await realpath(target) } catch { throw new Error(`File "${userPath}" does not exist in the project`) }
  if (!inside(real)) throw new Error(`Path "${userPath}" resolves outside the project (symlink)`)
  return real
}
// in execute: const file = await resolveInProject(ctx.location.directory, input.path)
```

It needs the file to exist. For a file you're about to create, check the resolved parent directory instead.

## Other hooks in `setup(ctx)`

| API | Use |
| --- | --- |
| `ctx.location.directory` | The directory opencode was started in, which is the project root when you start it there. Resolve relative paths against it, not `process.cwd()`. Only tested from the project root. |
| `await ctx.tool.hook("execute.before", async e => …)` | Runs before every tool call, built-in ones included (`e.tool`, `e.sessionID`, `e.input`). Async callbacks work. Calls the model makes inside Code Mode code show up as one `execute` call. |
| `await ctx.tool.hook("execute.after", e => …)` | Runs after a **successful** call (`e.tool`, `e.status === "completed"`, `e.result`), built-in ones included. Tested: it did **not** fire when the tool threw an error, although the types also allow `status: "error"`. For auditing, log in `execute.before`. |
| `await ctx.shell.hook("create.before", e => { e.env.X = "1" })` | Change `command`, `cwd`, `env` or `timeout` of shell commands the agent runs. *Only `env` was tested.* |
| `return () => {...}` from `setup` | Cleanup. Runs when opencode stops the plugin, and on reload. |

### Background processes (tested)

`spawn("node", ["-e", script], { detached: true, stdio: "ignore" }).unref()` starts a process that keeps running after the tool returns, after the plugin's cleanup and after opencode exits. Record the pid (for example in a file) if other tools need to check on it later, and redirect its output to files so it doesn't stay attached to opencode.

More domains exist (`session`, `event`, `agent`, `command`, `skill`, `mcp`, `provider`, `permission`, `storage`). Their types are in `dist/promise/plugin.d.ts` of `@opencode/plugin`.

## Verify

```zsh
oc_timeout 180 opencode run --standalone --auto --print-logs --log-level debug \
  "Call <your_tool> with ... and report its output verbatim." < /dev/null > run.log 2>&1   # oc_timeout: see below
grep -E 'loading plugin|failed to load plugin' run.log   # was it loaded, and without errors?
grep -v '^timestamp' run.log | tail -20                 # the model's transcript
```

- `failed to load plugin … cause=…` gives the reason (missing default export, unresolved import, syntax error).
- The model saying "no tool named X" means the plugin failed to load, `setup` returned before `t.add`, or a permission rule denies the tool.
- In the transcript, a successful call shows as `⚙ <tool> {...}`. A thrown error shows as `✗ <tool> {...} failed`, followed by `Error: <message>`.
- When testing a security guard (path traversal and similar), the model may refuse a bare prompt like "read ../../etc/passwd" as an attack. Say that you're the developer testing the guard and that the call is expected to fail.
- A transcript line like `⚙ notes_list Unknown` just means the tool was called with no arguments. It's harmless.
- Also check side effects directly (files written, processes started). The model's report alone isn't proof.
- The run log contains the tool calls but not their results. To prove the model really read a result (for example a file), put a value in the data that only the tool can return, and check that the model quotes it.
- To prove a `deny` rule works, also do a control run without it and check that the tool shows up there.
- **Always add `< /dev/null`** when you run `opencode run` from a script or an agent. When stdin isn't a terminal, opencode reads it and appends it to the prompt, and it waits forever if stdin is a pipe that never closes. The symptom is that nothing happens after the log line `cli starting`, and it looks like a random hang. Tested: with an open pipe as stdin the run hung every time; with `< /dev/null` it worked.
- **Always run with a timeout** as a safety net. Let it kill the whole process group. `opencode run` starts a child `serve --stdio` server, and a plain timeout on `opencode run` leaves that server orphaned.
  ```zsh
  # usage: oc_timeout <seconds> opencode run ...   (exit 124 = timed out)
  oc_timeout() { perl -e '$SIG{ALRM}=sub{$SIG{TERM}="IGNORE"; kill "TERM",-$$; exit 124}; setpgrp(0,0); alarm shift; exit(system(@ARGV)>>8)' "$@"; }
  oc_timeout 180 opencode run --standalone --auto --print-logs --log-level debug "..." < /dev/null > run.log 2>&1
  ```
  Don't use `pkill -f "serve --stdio"` to clean up. It also kills other opencode sessions on the machine.

## Plugin options (optional)

To pass settings to a plugin, put it in a directory inside the project with an `index.ts`, and reference it from `opencode.json`. Keep this directory outside `.opencode/plugins/`, because every `.ts` file there is loaded as a plugin on its own.

```json
{ "plugins": [{ "package": "./plugins/my-plugin", "options": { "endpoint": "https://example.test" } }] }
```

`setup` then receives the settings as `ctx.options` (tested: `ctx.options` was `{"k":"v"}` for `"options": {"k":"v"}`). Plugins in `.opencode/plugins/` get no settings this way. Only an `index.ts` entry point was tested.

Treat `ctx.options` as untrusted input: read it with defaults and type checks. For invalid values, fall back to the defaults and write a warning to your log file, rather than throwing in `setup` (see Debugging). `opencode run` reads it fresh on every run. Whether a running interactive session picks up a changed option without a restart is untested.

## Debugging

- `console.log` output is **not** shown. `console.error` appears in `--print-logs` output. For a durable trace, append to a log file (the template does this).
- opencode watches plugin files: when you save one, the log shows `cleanup` then `setup` again, even during a running session.
- Keep `setup` fast and don't let it throw. A slow `setup` delays startup, and code after an early `return` never registers the tools.

## Pitfalls (tested on 2.0.18)

- The file needs a **default export** with `id` and `setup`. Otherwise you get: *"Plugin must export a default definition with an id and an effect or setup function."*
- A `plugins` entry in `opencode.json` must point to a **directory**. A file path like `"./file.ts"` is skipped, with the warning *"configured plugin path must be a directory"*.
- `@opencode-ai/plugin` (even 1.18.x) is the **v1** SDK. The v2 SDK is `@opencode/plugin`, and its version matches the CLI.
- Tool names are global. Prefix them (`team_…`) so they don't clash with built-ins or other plugins.

## Optional: editor type checking

Nothing is needed at runtime. For IntelliSense and `tsc`:

```zsh
cd .opencode && npm i -D @opencode/plugin@$(opencode --version | awk '{print $2}' | tr -d v) @types/node
```

Then `satisfies Plugin.Plugin` (as in the template) type-checks the whole definition. The plugin still loads with these packages installed (tested). Add `.opencode/node_modules/` to `.gitignore`.
