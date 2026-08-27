import {
  classifyGitHubCallbackError,
  inspectLoginContinuationLocation,
  isInvalidOAuthContinuationError,
} from "@client/features/auth/login-continuation"
import { describe, expect, it } from "vitest"

function signedLoginLocation(
  expirationSeconds: number,
  issuedAtMilliseconds: number,
) {
  const params = new URLSearchParams({
    ba_iat: String(issuedAtMilliseconds),
    client_id: "eruoo-desktop",
    exp: String(expirationSeconds),
    state: "original-state",
  })

  for (const parameterName of [
    "ba_iat",
    "ba_param",
    "client_id",
    "exp",
    "state",
  ]) {
    params.append("ba_param", parameterName)
  }
  params.set("sig", "synthetic-signature")

  return `/login?${params}`
}

describe("login OAuth continuation", () => {
  it("keeps only a structurally current signed continuation", () => {
    const now = Date.UTC(2026, 7, 24, 12)
    const fullPath = `${signedLoginLocation(
      Math.floor(now / 1_000) + 600,
      now,
    )}&error=access_denied&error_description=synthetic-detail&unsigned=value`

    const result = inspectLoginContinuationLocation(fullPath, now)
    const callback = new URL(result.callbackLocation, "https://auth.eruoo.me")

    expect(result.status).toBe("current")
    expect(result.upstreamError).toBe("other")
    expect(result.normalizedLocation).toBe(result.callbackLocation)
    expect(callback.pathname).toBe("/login")
    expect(callback.searchParams.get("client_id")).toBe("eruoo-desktop")
    expect(callback.searchParams.get("state")).toBe("original-state")
    expect(callback.searchParams.get("error")).toBeNull()
    expect(callback.searchParams.get("error_description")).toBeNull()
    expect(callback.searchParams.get("unsigned")).toBeNull()
  })

  it.each([
    {
      label: "expired",
      location: signedLoginLocation(1_700_000_000, 1_699_999_400_000),
      now: 1_700_000_001_000,
    },
    {
      label: "missing expiration metadata",
      location:
        "/login?client_id=eruoo-desktop&ba_param=client_id&sig=forged-signature",
      now: Date.UTC(2026, 7, 24, 12),
    },
  ])("clears an $label signed continuation", ({ location, now }) => {
    expect(inspectLoginContinuationLocation(location, now)).toMatchObject({
      callbackLocation: "/login",
      normalizedLocation: "/login",
      status: "invalid",
    })
  })

  it("removes an ordinary GitHub error without inventing a continuation", () => {
    expect(
      inspectLoginContinuationLocation(
        "/login?source=management&error=access_denied&error_description=detail",
      ),
    ).toEqual({
      callbackLocation: "/login",
      normalizedLocation: "/login?source=management",
      status: "absent",
      upstreamError: "other",
    })
  })

  it("classifies only an exact owner rejection without retaining upstream detail", () => {
    const result = inspectLoginContinuationLocation(
      "/login?error=owner_not_allowed&error_description=private-upstream-detail",
    )

    expect(result).toEqual({
      callbackLocation: "/login",
      normalizedLocation: "/login",
      status: "absent",
      upstreamError: "owner-not-allowed",
    })
    expect(result.normalizedLocation).not.toContain("private-upstream-detail")

    expect(
      inspectLoginContinuationLocation(
        "/login?error=owner_not_allowed&error=access_denied",
      ).upstreamError,
    ).toBe("other")
  })

  it.each([
    [
      "a duplicated owner rejection",
      "error=owner_not_allowed&error=owner_not_allowed",
    ],
    ["mixed errors", "error=owner_not_allowed&error=access_denied"],
    ["an error description without an error code", "error_description=detail"],
  ])("classifies %s as a generic callback error", (_label, query) => {
    expect(classifyGitHubCallbackError(new URLSearchParams(query))).toBe(
      "other",
    )
  })

  it("recognizes invalid-signature failures without trusting arbitrary text", () => {
    expect(
      isInvalidOAuthContinuationError({
        response: { body: { error: "invalid_signature" } },
      }),
    ).toBe(true)
    expect(
      isInvalidOAuthContinuationError({
        error: "The signature was invalid_signature yesterday.",
      }),
    ).toBe(false)
  })
})
