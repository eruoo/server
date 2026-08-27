import { readFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"

import { describe, expect, it } from "vitest"

const staticHeadersPath = fileURLToPath(
  new URL("../public/_headers", import.meta.url),
)

function readRule(source: string, pattern: string): string {
  const rule = source
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .find((block) => block.split(/\r?\n/, 1)[0] === pattern)

  if (!rule) throw new Error(`Missing static header rule: ${pattern}`)
  return rule
}

describe("static asset cache headers", () => {
  it("keeps the SPA revalidation policy separate from immutable assets", async () => {
    const source = await readFile(staticHeadersPath, "utf8")
    const fallbackRule = readRule(source, "/*")
    const assetRule = readRule(source, "/assets/*")
    const scalarRule = readRule(source, "/scalar/*")

    expect(fallbackRule).not.toMatch(/^\s+Cache-Control:/im)
    expect(assetRule).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    )
    expect(scalarRule).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    )
  })
})
