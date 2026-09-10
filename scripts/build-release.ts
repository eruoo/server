import { spawnSync, execFileSync } from "node:child_process"
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import path from "node:path"

import { parse } from "jsonc-parser"

import { artifactDigests, digest } from "./lib/release-artifact"
const environment = process.argv[2]
if (environment !== "staging" && environment !== "production")
  throw new Error("Choose staging or production")
const source = parse(await readFile("wrangler.jsonc", "utf8"))
const namespaces = ["staging", "production"].flatMap((target) =>
  source.env[target].ratelimits.map(
    (binding: { namespace_id: string }) => binding.namespace_id,
  ),
)
if (namespaces.length !== 4 || new Set(namespaces).size !== 4)
  throw new Error("Each remote rate limiter must have an isolated namespace")
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
const build = spawnSync("pnpm", ["exec", "vite", "build"], {
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_ENV: environment },
})
if (build.status !== 0) process.exit(build.status ?? 1)
const destination = path.resolve(`.output/releases/${environment}`)
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp("dist", path.join(destination, "build"), {
  recursive: true,
  filter: (source) =>
    !/^\.dev\.vars(?:\.|$)|^\.env(?:\.|$)/.test(path.basename(source)),
})
await cp("migrations", path.join(destination, "migrations"), {
  recursive: true,
})
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
  await cp(file, path.join(destination, file))
await cp("patches", path.join(destination, "patches"), { recursive: true })
const deploy = JSON.parse(
  await readFile(".wrangler/deploy/config.json", "utf8"),
)
const sourceConfig = path.resolve(".wrangler/deploy", deploy.configPath)
const configPath = path.join(
  destination,
  "build",
  path.relative(path.resolve("dist"), sourceConfig),
)
const config = JSON.parse(await readFile(configPath, "utf8"))
const migrations = await artifactDigests(path.join(destination, "migrations"))
config.vars.RELEASE_SHA = sha
config.vars.RELEASE_MIGRATIONS = JSON.stringify(migrations)
for (const database of config.d1_databases)
  database.migrations_dir = path.relative(
    path.dirname(configPath),
    path.join(destination, "migrations"),
  )
delete config.configPath
delete config.userConfigPath
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
const pkg = JSON.parse(await readFile("package.json", "utf8"))
const manifest = {
  version: 1,
  sha,
  environment,
  repository: process.env.GITHUB_REPOSITORY ?? "local",
  runId: process.env.GITHUB_RUN_ID ?? "local",
  createdAt: new Date().toISOString(),
  config: path.relative(destination, configPath).split(path.sep).join("/"),
  wrangler: pkg.devDependencies.wrangler,
  files: await artifactDigests(destination),
}
await writeFile(
  path.join(destination, "release.json"),
  JSON.stringify(manifest, null, 2) + "\n",
)
console.log(
  JSON.stringify({
    environment,
    sha,
    config: manifest.config,
    files: Object.keys(manifest.files).length,
    manifestSha256: digest(JSON.stringify(manifest)),
  }),
)
