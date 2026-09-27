import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const gitBash = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`
const bash = process.env.ABW_BASH ?? (process.platform === "win32" && existsSync(gitBash) ? gitBash : "bash")
const launcher = spawn(bash, ["scripts/abw.sh", ...process.argv.slice(2)], { stdio: "inherit" })

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true

  if (process.platform === "win32" && launcher.pid) {
    spawnSync("taskkill.exe", ["/pid", String(launcher.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
  } else {
    launcher.kill(signal)
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.once(signal, () => stop(signal))

launcher.once("error", (error) => {
  console.error(`failed to start ${bash}: ${error.message}`)
  process.exitCode = 1
})

launcher.once("exit", (code) => {
  process.exitCode = stopping ? 0 : (code ?? 1)
})