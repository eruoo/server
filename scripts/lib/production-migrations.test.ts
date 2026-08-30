import { describe, expect, it } from "vitest"

import {
  isProductionMigrationFileName,
  parseProductionMigrationFileName,
} from "./production-migrations"

describe("production migration filenames", () => {
  it.each([
    "0001_foundation.sql",
    "0002_expand_user.sql",
    "0003_expand-user.sql",
  ])("accepts %s", (name) => {
    expect(isProductionMigrationFileName(name)).toBe(true)
  })

  it.each([
    "001_foundation.sql",
    "0002__expand.sql",
    "0002_-expand.sql",
    "0002_Expand.sql",
    "0002_expand.txt",
  ])("rejects %s", (name) => {
    expect(isProductionMigrationFileName(name)).toBe(false)
  })

  it("returns the canonical four-digit sequence", () => {
    expect(parseProductionMigrationFileName("0042_expand.sql")).toEqual({
      sequence: 42,
      sequenceText: "0042",
    })
  })
})
