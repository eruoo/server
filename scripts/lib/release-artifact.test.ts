import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { expect, it } from "vitest"

import { artifactDigests, verifyArtifact } from "./release-artifact"
it("rejects altered, stale, wrong-source and wrong-environment artifacts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eruoo-release-"))
  try {
    await writeFile(path.join(dir, "wrangler.json"), "{}")
    const manifest = {
      version: 1,
      sha: "a".repeat(40),
      environment: "staging",
      repository: "eruoo/server",
      runId: "123",
      createdAt: new Date().toISOString(),
      config: "wrangler.json",
      wrangler: "4.124.0",
      files: await artifactDigests(dir),
    }
    await writeFile(path.join(dir, "release.json"), JSON.stringify(manifest))
    await expect(
      verifyArtifact(dir, manifest.sha, "staging", "123"),
    ).resolves.toMatchObject({ sha: manifest.sha })
    await expect(
      verifyArtifact(dir, "b".repeat(40), "staging"),
    ).rejects.toThrow("mismatch")
    await expect(
      verifyArtifact(dir, manifest.sha, "production"),
    ).rejects.toThrow("mismatch")
    await expect(
      verifyArtifact(
        dir,
        manifest.sha,
        "staging",
        "123",
        Date.now() + 8 * 86400000,
      ),
    ).rejects.toThrow("expired")
    await writeFile(path.join(dir, "wrangler.json"), "changed")
    await expect(verifyArtifact(dir, manifest.sha, "staging")).rejects.toThrow(
      "digest",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
