import { execFile, spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const { stdout } = await execFileAsync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
)
const stagedPaths = stdout
  .toString("utf8")
  .split("\0")
  .filter((filePath) => filePath.length > 0)

if (stagedPaths.length === 0) {
  process.stdout.write("No staged files need secret scanning.\n")
  process.exit(0)
}

const snapshotDirectory = await mkdtemp(
  path.join(os.tmpdir(), "eruoo-secret-scan-"),
)

try {
  for (const filePath of stagedPaths) {
    const targetPath = path.resolve(snapshotDirectory, filePath)
    const snapshotPrefix = `${snapshotDirectory}${path.sep}`

    if (!targetPath.startsWith(snapshotPrefix)) {
      throw new Error(`Refusing to materialize an unsafe Git path: ${filePath}`)
    }

    const { stdout: contents } = await execFileAsync(
      "git",
      ["show", `:${filePath}`],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    )
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents)
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const scanner = spawn(
      "pnpm",
      [
        "exec",
        "secretlint",
        "--no-gitignore",
        path.join(snapshotDirectory, "**/*"),
      ],
      { stdio: "inherit" },
    )

    scanner.once("error", reject)
    scanner.once("exit", (code) => resolve(code ?? 1))
  })

  if (exitCode !== 0) process.exitCode = exitCode
} finally {
  await rm(snapshotDirectory, { force: true, recursive: true })
}
