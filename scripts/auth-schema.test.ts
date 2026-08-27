import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import {
  assertNoVirtualTables,
  disallowVirtualTableCreation,
} from "./lib/auth-schema"

describe("auth schema policy", () => {
  it("rejects a real SQLite virtual table", () => {
    const database = new DatabaseSync(":memory:")

    try {
      database.exec("CREATE VIRTUAL TABLE search USING fts5(value)")

      expect(() => assertNoVirtualTables(database)).toThrow(
        "D1 virtual table search is not allowed by the backup contract",
      )
    } finally {
      database.close()
    }
  })

  it("rejects comment-separated virtual-table creation before a later drop", () => {
    const database = new DatabaseSync(":memory:")

    try {
      disallowVirtualTableCreation(database)

      expect(() =>
        database.exec(`
          CREATE /* backup-contract bypass */ VIRTUAL TABLE transient_search
          USING fts5(content);
          DROP TABLE transient_search;
        `),
      ).toThrow("not authorized")
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sqlite_schema
             WHERE name = 'transient_search'`,
          )
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })
})
