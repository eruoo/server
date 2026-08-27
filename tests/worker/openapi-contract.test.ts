import { describe, expect, it } from "vitest"

import {
  assertOpenApiContract,
  assertProtectedOperationsRejectAnonymous,
} from "../../scripts/openapi-contract"

function operation({
  operationId = "getExample",
  responses = {
    200: { description: "Success" },
    401: { description: "Authentication required" },
  },
  security = [{ ownerSession: [] }],
}: {
  operationId?: string
  responses?: Record<number, { description: string }>
  security?: unknown[]
} = {}) {
  return { operationId, responses, security }
}

describe("OpenAPI contract invariants", () => {
  it("accepts globally unique protected and explicitly allowlisted public operations", () => {
    const document = {
      paths: {
        "/api/private": { get: operation() },
        "/api/public": {
          get: operation({
            operationId: "getPublicExample",
            responses: { 200: { description: "Success" } },
            security: [],
          }),
        },
      },
    }

    expect(() =>
      assertOpenApiContract({
        document,
        publicOperationAllowlist: ["GET /api/public"],
      }),
    ).not.toThrow()
  })

  it("rejects duplicate operation IDs and missing operation-level security", () => {
    const document = {
      paths: {
        "/api/first": { get: operation() },
        "/api/second": {
          get: {
            operationId: "getExample",
            responses: { 200: { description: "Success" } },
          },
        },
      },
    }

    expect(() =>
      assertOpenApiContract({ document, publicOperationAllowlist: [] }),
    ).toThrowError(/must declare operation-level security/)
    expect(() =>
      assertOpenApiContract({ document, publicOperationAllowlist: [] }),
    ).toThrowError(/operationId getExample is used by both/)
  })

  it("keeps public operations and the explicit allowlist in exact sync", () => {
    const document = {
      paths: {
        "/api/public": {
          get: operation({
            responses: { 200: { description: "Success" } },
            security: [],
          }),
        },
      },
    }

    expect(() =>
      assertOpenApiContract({ document, publicOperationAllowlist: [] }),
    ).toThrowError(/GET \/api\/public is public but is missing/)
    expect(() =>
      assertOpenApiContract({
        document,
        publicOperationAllowlist: ["GET /api/missing"],
      }),
    ).toThrowError(/GET \/api\/missing is allowlisted as public but is absent/)
  })

  it("requires concrete success and anonymous 401 response declarations", () => {
    const document = {
      paths: {
        "/api/private": {
          get: operation({
            responses: { 500: { description: "Failure" } },
          }),
        },
      },
    }

    expect(() =>
      assertOpenApiContract({ document, publicOperationAllowlist: [] }),
    ).toThrowError(
      /must declare at least one concrete 2xx.*must declare a 401/s,
    )
  })
})

describe("OpenAPI anonymous runtime checks", () => {
  it("automatically probes fixed GET operations without credentials", async () => {
    const document = {
      paths: {
        "/api/private": { get: operation() },
      },
    }
    const requests: unknown[] = []

    await assertProtectedOperationsRejectAnonymous({
      document,
      invoke: async (request) => {
        requests.push(request)
        return new Response(null, { status: 401 })
      },
      publicOperationAllowlist: [],
      requestFixtures: {},
    })

    expect(requests).toEqual([{ method: "GET", path: "/api/private" }])
  })

  it("fails closed for operations that need an explicit request fixture", async () => {
    const document = {
      paths: {
        "/api/items/{itemId}": {
          post: {
            ...operation({ operationId: "updateItem" }),
            requestBody: { required: true },
          },
        },
      },
    }
    const requests: unknown[] = []
    const invoke = async (request: unknown) => {
      requests.push(request)
      return new Response(null, { status: 401 })
    }

    await expect(
      assertProtectedOperationsRejectAnonymous({
        document,
        invoke,
        publicOperationAllowlist: [],
        requestFixtures: {},
      }),
    ).rejects.toThrowError(
      /needs an explicit anonymous runtime request fixture/,
    )

    await assertProtectedOperationsRejectAnonymous({
      document,
      invoke,
      publicOperationAllowlist: [],
      requestFixtures: {
        "POST /api/items/{itemId}": {
          body: "{}",
          headers: { "content-type": "application/json" },
          path: "/api/items/synthetic-item",
        },
      },
    })

    expect(requests.at(-1)).toEqual({
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
      path: "/api/items/synthetic-item",
    })
  })

  it("rejects credentials in fixtures and non-401 runtime responses", async () => {
    const document = {
      paths: {
        "/api/private": { post: operation() },
      },
    }

    await expect(
      assertProtectedOperationsRejectAnonymous({
        document,
        invoke: async () => new Response(null, { status: 401 }),
        publicOperationAllowlist: [],
        requestFixtures: {
          "POST /api/private": {
            headers: { Authorization: "Bearer synthetic" },
            path: "/api/private",
          },
        },
      }),
    ).rejects.toThrowError(/must not contain credential header Authorization/)

    await expect(
      assertProtectedOperationsRejectAnonymous({
        document,
        invoke: async () => new Response(null, { status: 200 }),
        publicOperationAllowlist: [],
        requestFixtures: {
          "POST /api/private": { path: "/api/private" },
        },
      }),
    ).rejects.toThrowError(/returned 200.*expected 401/)
  })
})
