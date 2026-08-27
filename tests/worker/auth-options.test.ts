import { describe, expect, it } from "vitest"

import { isOwnerAuthenticationSource } from "../../src/worker/auth"

const ownerGitHubId = "50254496"

describe("owner identity gate", () => {
  it("accepts the configured immutable GitHub numeric ID", () => {
    expect(
      isOwnerAuthenticationSource(
        {
          method: "oauth",
          oauth: {
            profile: { id: 50254496, login: "display-name-is-not-an-anchor" },
            providerId: "github",
          },
        },
        ownerGitHubId,
      ),
    ).toBe(true)
  })

  it.each([
    {
      method: "oauth",
      oauth: { profile: { id: "123" }, providerId: "github" },
    },
    {
      method: "oauth",
      oauth: { profile: { id: ownerGitHubId }, providerId: "google" },
    },
    { method: "email-password" },
    {
      method: "oauth",
      oauth: { profile: {}, providerId: "github" },
    },
  ])("rejects a non-owner authentication source", (source) => {
    expect(isOwnerAuthenticationSource(source, ownerGitHubId)).toBe(false)
  })
})
