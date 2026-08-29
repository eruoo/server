import { describe, expect, it } from "vitest"

import playwrightConfig from "../playwright.config"
import {
  e2eOrigin,
  e2ePort,
  e2eReadinessOrigin,
  e2eServerHost,
} from "../tests/client/e2e/support"

describe("Playwright server contract", () => {
  it("binds both loopback families while keeping a localhost WebAuthn origin", () => {
    const webServers = Array.isArray(playwrightConfig.webServer)
      ? playwrightConfig.webServer
      : [playwrightConfig.webServer]

    expect(playwrightConfig.use?.baseURL).toBe(e2eOrigin)
    expect(webServers).toHaveLength(1)
    expect(webServers[0]).toMatchObject({
      command: `pnpm dev --mode e2e --host ${e2eServerHost} --port ${e2ePort}`,
      reuseExistingServer: false,
      url: e2eReadinessOrigin,
    })
  })
})
