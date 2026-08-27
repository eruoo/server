import { describe, expect, it } from "vitest"

import { OWNER_GITHUB_ID } from "../../src/shared/security"
import type { AuthEnv } from "../../src/worker/config"
import {
  getRuntimeConfig,
  parseVersionedSecrets,
  RuntimeConfigError,
} from "../../src/worker/config"

function productionEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    ALLOWED_CORS_ORIGINS: '["https://app.eruoo.me"]',
    APP_ENV: "production",
    APP_ORIGIN: "https://auth.eruoo.me",
    BETTER_AUTH_SECRETS:
      "2:synthetic-current-secret-at-least-thirty-two-characters,1:synthetic-old-secret-at-least-thirty-two-characters",
    GITHUB_CLIENT_ID: "synthetic-client-id",
    GITHUB_CLIENT_SECRET: "synthetic-client-secret",
    OWNER_GITHUB_ID,
    ...overrides,
  }
}

describe("runtime configuration", () => {
  it("parses the fixed production identity origin and exact CORS origins", () => {
    const config = getRuntimeConfig(productionEnv())

    expect(config.appOrigin).toBe("https://auth.eruoo.me")
    expect(config.passkeyRpId).toBe("auth.eruoo.me")
    expect([...config.allowedCorsOrigins]).toEqual(["https://app.eruoo.me"])
    expect(config.betterAuthSecrets.map(({ version }) => version)).toEqual([
      2, 1,
    ])
  })

  it.each([
    { APP_ENV: "staging" },
    { APP_ORIGIN: "https://preview.example.com" },
    { APP_ORIGIN: "https://auth.eruoo.me/identity" },
    { ALLOWED_CORS_ORIGINS: '["https://*.eruoo.me"]' },
    { ALLOWED_CORS_ORIGINS: '["https://app.eruoo.me/path"]' },
    { ALLOWED_CORS_ORIGINS: '["http://app.eruoo.me"]' },
    { OWNER_GITHUB_ID: "123" },
    { OWNER_GITHUB_ID: "owner-name" },
  ])("rejects unsafe production configuration", (overrides) => {
    expect(() =>
      getRuntimeConfig(productionEnv(overrides as Partial<AuthEnv>)),
    ).toThrow(RuntimeConfigError)
  })

  it("allows HTTP CORS origins only for loopback development", () => {
    const loopback = getRuntimeConfig(
      productionEnv({
        ALLOWED_CORS_ORIGINS: '["http://127.0.0.1:4173"]',
        APP_ENV: "development",
        APP_ORIGIN: "http://localhost:5173",
      }),
    )

    expect([...loopback.allowedCorsOrigins]).toEqual(["http://127.0.0.1:4173"])
    expect(() =>
      getRuntimeConfig(
        productionEnv({
          ALLOWED_CORS_ORIGINS: '["http://web.example.invalid"]',
          APP_ENV: "development",
          APP_ORIGIN: "http://localhost:5173",
        }),
      ),
    ).toThrow(RuntimeConfigError)
  })

  it("rejects duplicate Better Auth secret versions", () => {
    expect(() =>
      parseVersionedSecrets(
        "1:synthetic-first-secret-at-least-thirty-two-characters,1:synthetic-second-secret-at-least-thirty-two-characters",
      ),
    ).toThrow(RuntimeConfigError)
  })

  it("rejects a secret rotation list that does not put the newest first", () => {
    expect(() =>
      parseVersionedSecrets(
        "1:synthetic-old-secret-at-least-thirty-two-characters,2:synthetic-new-secret-at-least-thirty-two-characters",
      ),
    ).toThrow(RuntimeConfigError)
  })
})
