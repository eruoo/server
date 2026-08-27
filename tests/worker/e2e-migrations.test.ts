import { describe, expect, it } from "vitest"

import { splitD1MigrationStatements } from "./e2e-migrations"

describe("E2E D1 migration parsing", () => {
  it("removes SQL comments without rewriting quoted literals", () => {
    const statements = splitD1MigrationStatements(`
      -- migration header
      CREATE TABLE "example" (
        "value" TEXT DEFAULT 'two  spaces; -- literal'
      );
      /* a block comment containing ; */
      CREATE INDEX "example_value_idx" ON "example" ("value");
    `)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("'two  spaces; -- literal'")
    expect(statements[1]).toContain('CREATE INDEX "example_value_idx"')
  })

  it("rejects an unterminated quoted token", () => {
    expect(() =>
      splitD1MigrationStatements("CREATE TABLE example (value TEXT DEFAULT '"),
    ).toThrow("unterminated SQL token")
  })
})
