import {
  AuthorizedApplicationsApiError,
  createAuthorizedApplicationsService,
} from "@client/features/security/authorized-applications-service"
import {
  createEruooApiClient,
  type EruooApiFetch,
} from "@client/lib/api-client"
import { requiresRecentAuthentication } from "@client/lib/auth-errors"
import { OAUTH_RESOURCE } from "@shared/oauth"
import { beforeEach, describe, expect, it, vi } from "vitest"

const validAuthorizations = [
  {
    activeRefreshTokenCount: 0,
    authorized: false,
    clientId: "eruoo-web",
    consentCount: 0,
    enabled: false,
    lastAuthorizedAt: null,
    name: "eruoo Web",
    offlineAccess: false,
    platform: "web",
    resources: [],
    scopes: [],
    supportsOfflineAccess: false,
  },
  {
    activeRefreshTokenCount: 1,
    authorized: true,
    clientId: "eruoo-desktop",
    consentCount: 1,
    enabled: true,
    lastAuthorizedAt: Date.parse("2026-08-21T03:04:05.000Z"),
    name: "eruoo Desktop",
    offlineAccess: true,
    platform: "desktop",
    resources: [OAUTH_RESOURCE],
    scopes: ["openid", "offline_access"],
    supportsOfflineAccess: true,
  },
  {
    activeRefreshTokenCount: 0,
    authorized: false,
    clientId: "eruoo-mobile",
    consentCount: 0,
    enabled: false,
    lastAuthorizedAt: null,
    name: "eruoo Mobile",
    offlineAccess: false,
    platform: "mobile",
    resources: [],
    scopes: [],
    supportsOfflineAccess: true,
  },
]

function jsonResponse(
  body: unknown,
  options: { contentType?: string; status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": options.contentType ?? "application/json",
    },
    status: options.status ?? 200,
  })
}

describe("authorized applications service", () => {
  const fetcher = vi.fn<EruooApiFetch>()
  const service = createAuthorizedApplicationsService(
    createEruooApiClient(fetcher),
  )

  beforeEach(() => {
    fetcher.mockReset()
  })

  it("loads and strictly parses the same-origin authorization summary", async () => {
    fetcher.mockResolvedValue(jsonResponse(validAuthorizations))

    const authorizations = await service.list()

    expect(fetcher).toHaveBeenCalledOnce()
    const request = fetcher.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      `${window.location.origin}/api/oauth/authorizations`,
    )
    expect(request?.method).toBe("GET")
    expect(request?.credentials).toBe("include")
    expect(request?.headers.get("accept")).toBe(
      "application/json, application/problem+json",
    )
    expect(authorizations).toEqual(validAuthorizations)
  })

  it("fails closed on extra fields or inconsistent authorization state", async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse([
        { ...validAuthorizations[0], unexpected: true },
        validAuthorizations[1],
        validAuthorizations[2],
      ]),
    )

    await expect(service.list()).rejects.toThrow(
      "OAuth authorization response is invalid.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse([
        validAuthorizations[0],
        {
          ...validAuthorizations[1],
          authorized: false,
        },
        validAuthorizations[2],
      ]),
    )

    await expect(service.list()).rejects.toThrow(
      "OAuth authorization invariants are invalid.",
    )
  })

  it("revokes a native authorization through the client-scoped DELETE API", async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        clientId: "eruoo-desktop",
        deletedConsentCount: 1,
        revokedRefreshTokenCount: 2,
      }),
    )

    await service.revoke("eruoo-desktop")

    const request = fetcher.mock.calls[0]?.[0]
    expect(request?.url).toBe(
      `${window.location.origin}/api/oauth/authorizations/eruoo-desktop`,
    )
    expect(request?.method).toBe("DELETE")
    expect(request?.credentials).toBe("include")
  })

  it("never sends an owner revocation request for Web", async () => {
    await expect(service.revoke("eruoo-web")).rejects.toThrow(
      "Web authorization is not owner-revocable.",
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("preserves a valid recent-authentication Problem for the UI", async () => {
    fetcher.mockResolvedValue(
      jsonResponse(
        {
          detail:
            "This operation requires authentication within the last 15 minutes.",
          requestId: "synthetic-request-id",
          status: 403,
          title: "Recent authentication required",
          type: "https://auth.eruoo.me/problems/recent-authentication-required",
        },
        { contentType: "application/problem+json", status: 403 },
      ),
    )

    let thrown: unknown
    try {
      await service.revoke("eruoo-mobile")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AuthorizedApplicationsApiError)
    expect(requiresRecentAuthentication(thrown)).toBe(true)
  })

  it("does not trust malformed JSON, media types, or Problem status", async () => {
    fetcher.mockResolvedValueOnce(
      new Response("not-json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    )
    await expect(service.list()).rejects.toThrow(
      "API response is not valid JSON.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse(validAuthorizations, { contentType: "text/plain" }),
    )
    await expect(service.list()).rejects.toThrow(
      "API success response is invalid.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: "Mismatched status must not be trusted.",
          requestId: "synthetic-request-id",
          status: 401,
          title: "Authentication required",
          type: "https://auth.eruoo.me/problems/authentication-required",
        },
        { contentType: "application/problem+json", status: 403 },
      ),
    )

    let thrown: unknown
    try {
      await service.revoke("eruoo-mobile")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AuthorizedApplicationsApiError)
    expect(requiresRecentAuthentication(thrown)).toBe(false)
  })
})
