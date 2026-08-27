import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import {
  e2eBootstrapPath,
  e2eBootstrapToken,
  e2eCurrentSessionPath,
  e2eStaleSessionPath,
} from "../client/e2e/support"

describe("the production Worker entrypoint", () => {
  it.each([
    ["POST", e2eBootstrapPath],
    ["GET", e2eCurrentSessionPath],
    ["POST", e2eStaleSessionPath],
  ])("never exposes the E2E fixture at %s %s", async (method, path) => {
    const response = await SELF.fetch(`https://auth.eruoo.me${path}`, {
      headers: {
        "x-e2e-bootstrap-token": e2eBootstrapToken,
      },
      method,
    })

    expect(response.status).toBe(404)
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})
