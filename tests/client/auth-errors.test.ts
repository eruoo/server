import { ApiResponseError } from "@client/lib/api-response"
import {
  requiresAuthentication,
  requiresRecentAuthentication,
} from "@client/lib/auth-errors"
import { describe, expect, it } from "vitest"

describe("requiresRecentAuthentication", () => {
  it("does not infer recent authentication from an untyped 403", () => {
    expect(requiresRecentAuthentication({ status: 403 })).toBe(false)
    expect(
      requiresRecentAuthentication({ response: { statusCode: 403 } }),
    ).toBe(false)
  })

  it("does not turn unrelated failures into a reauthentication prompt", () => {
    expect(requiresRecentAuthentication({ status: 401 })).toBe(false)
    expect(requiresRecentAuthentication(new Error("offline"))).toBe(false)
  })

  it("uses canonical Problem types to distinguish different 403 responses", () => {
    expect(
      requiresRecentAuthentication({
        problem: {
          status: 403,
          type: "https://auth.eruoo.me/problems/recent-authentication-required",
        },
        status: 403,
      }),
    ).toBe(true)
    expect(
      requiresRecentAuthentication({
        problem: {
          status: 403,
          type: "https://auth.eruoo.me/problems/permission-denied",
        },
        status: 403,
      }),
    ).toBe(false)
  })

  it("rejects a recent-authentication type whose status is not 403", () => {
    expect(
      requiresRecentAuthentication({
        status: 500,
        type: "https://auth.eruoo.me/problems/recent-authentication-required",
      }),
    ).toBe(false)
    expect(
      requiresRecentAuthentication({
        problem: {
          status: 403,
          type: "https://auth.eruoo.me/problems/recent-authentication-required",
        },
        status: 500,
      }),
    ).toBe(false)
  })
})

describe("requiresAuthentication", () => {
  it.each(["authentication-required", "invalid-credential"])(
    "recognizes the canonical %s Problem type",
    (problemSlug) => {
      expect(
        requiresAuthentication(
          new ApiResponseError("Authentication failed.", {
            detail: "Authentication failed.",
            requestId: "synthetic-request-id",
            status: 401,
            title: "Authentication failed",
            type: `https://auth.eruoo.me/problems/${problemSlug}`,
          }),
        ),
      ).toBe(true)
    },
  )

  it("does not infer an expired Session from status codes or unrelated Problems", () => {
    expect(requiresAuthentication({ status: 401 })).toBe(false)
    expect(
      requiresAuthentication(
        new ApiResponseError("The service is unavailable.", {
          detail: "The service is unavailable.",
          requestId: "synthetic-request-id",
          status: 503,
          title: "Service unavailable",
          type: "https://auth.eruoo.me/problems/service-unavailable",
        }),
      ),
    ).toBe(false)
    expect(
      requiresAuthentication({
        type: "https://example.com/problems/invalid-credential",
      }),
    ).toBe(false)
    expect(
      requiresAuthentication({
        problem: {
          type: "https://auth.eruoo.me/problems/invalid-credential",
        },
      }),
    ).toBe(false)
  })

  it.each([
    ["authentication-required", 503],
    ["invalid-credential", 500],
  ])(
    "rejects the canonical %s type when its status is %i",
    (problemSlug, status) => {
      expect(
        requiresAuthentication(
          new ApiResponseError("Mismatched authentication Problem.", {
            detail: "Mismatched authentication Problem.",
            requestId: "synthetic-request-id",
            status,
            title: "Mismatched authentication Problem",
            type: `https://auth.eruoo.me/problems/${problemSlug}`,
          }),
        ),
      ).toBe(false)
    },
  )
})
