import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"
export const releaseManifestSchema = z
  .object({
    version: z.literal(1),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    environment: z.enum(["staging", "production"]),
    repository: z.string(),
    runId: z.string(),
    createdAt: z.string().datetime(),
    config: z.string(),
    wrangler: z.string(),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict()
export const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex")
export async function listArtifactFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!prefix && entry.name === "node_modules") continue
    if (entry.isSymbolicLink())
      throw new Error("Release artifacts cannot contain symlinks")
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory())
      result.push(
        ...(await listArtifactFiles(
          path.join(directory, entry.name),
          relative,
        )),
      )
    else if (entry.isFile() && relative !== "release.json")
      result.push(relative)
    else if (!entry.isFile()) throw new Error("Unsupported release entry")
  }
  return result.sort()
}
export async function artifactDigests(directory: string) {
  const result: Record<string, string> = {}
  for (const file of await listArtifactFiles(directory)) {
    if (/(^|\/)(\.dev\.vars|\.env)(\.|$)/.test(file))
      throw new Error("Local credentials must not enter a release artifact")
    result[file] = digest(await readFile(path.join(directory, file)))
  }
  return result
}
export async function verifyArtifact(
  directory: string,
  sha: string,
  environment: string,
  runId?: string,
  now = Date.now(),
) {
  const manifest = releaseManifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, "release.json"), "utf8")),
  )
  if (
    manifest.sha !== sha ||
    manifest.environment !== environment ||
    (runId !== undefined && manifest.runId !== runId)
  )
    throw new Error("Release source or environment mismatch")
  if (
    Date.parse(manifest.createdAt) > now ||
    now - Date.parse(manifest.createdAt) > 7 * 86400000
  )
    throw new Error("Release artifact has expired")
  if (!manifest.files[manifest.config])
    throw new Error("Release configuration is not in the manifest")
  const files = await artifactDigests(directory)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("Release artifact digest mismatch")
  return manifest
}
