import { env, SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import {
  enabledOAuthClients,
  oauthClients,
  oauthScopes,
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
  OAUTH_RESOURCE,
} from "../../src/shared/oauth"
import { createApp } from "../../src/worker/app"
import {
  isCanonicalOAuthScope,
  parseOAuthFormRequest,
} from "../../src/worker/auth/oauth-protocol"

const localIssuer = "http://localhost:5173"
const allowedWebOrigin = "https://web.example.invalid"

interface AuthorizationServerMetadata {
  grant_types_supported: string[]
  issuer: string
  jwks_uri: string
  registration_endpoint?: string
  revocation_endpoint_auth_methods_supported: string[]
  scopes_supported: string[]
  token_endpoint_auth_methods_supported: string[]
}

function authorizationUrl(clientId: string, scope = "openid profile api:read") {
  const url = new URL("http://local.test/api/auth/oauth2/authorize")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("code_challenge", "A".repeat(43))
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("redirect_uri", "http://127.0.0.1:49152/oauth/callback")
  url.searchParams.set("resource", OAUTH_RESOURCE)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", scope)
  url.searchParams.set("state", "synthetic-state")
  return url
}

function environmentWithCorsOrigin(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "ALLOWED_CORS_ORIGINS") {
        return JSON.stringify([allowedWebOrigin])
      }

      return Reflect.get(target, property, receiver)
    },
  })
}

describe("OAuth and OIDC metadata", () => {
  it("publishes consistent root-issuer metadata for public clients", async () => {
    const [authorizationServerResponse, openIdResponse] = await Promise.all([
      SELF.fetch("http://local.test/.well-known/oauth-authorization-server"),
      SELF.fetch("http://local.test/.well-known/openid-configuration"),
    ])

    expect(authorizationServerResponse.status).toBe(200)
    expect(openIdResponse.status).toBe(200)

    const authorizationServer =
      await authorizationServerResponse.json<AuthorizationServerMetadata>()
    const openId = await openIdResponse.json<AuthorizationServerMetadata>()

    for (const metadata of [authorizationServer, openId]) {
      expect(metadata.issuer).toBe(localIssuer)
      expect(metadata.jwks_uri).toBe(`${localIssuer}/api/auth/jwks`)
      expect(metadata.scopes_supported).toEqual(oauthScopes)
      expect(metadata.grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ])
      expect(metadata.token_endpoint_auth_methods_supported).toContain("none")
      expect(metadata.revocation_endpoint_auth_methods_supported).toContain(
        "none",
      )
      expect(metadata.registration_endpoint).toBeUndefined()
    }

    expect(authorizationServer.issuer).toBe(openId.issuer)
    expect(authorizationServer.jwks_uri).toBe(openId.jwks_uri)
    expect(authorizationServerResponse.headers.get("cache-control")).toBe(
      "public, max-age=300",
    )
  })

  it("publishes RFC 9728 protected-resource metadata", async () => {
    const response = await SELF.fetch(
      "http://local.test/.well-known/oauth-protected-resource/api",
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      authorization_servers: [localIssuer],
      bearer_methods_supported: ["header"],
      resource: OAUTH_RESOURCE,
      scopes_supported: ["api:read", "api:write"],
    })
  })

  it("keeps internal metadata aliases and dynamic registration closed", async () => {
    const responses = await Promise.all([
      SELF.fetch("http://local.test/api/auth/.well-known/openid-configuration"),
      SELF.fetch("http://local.test/api/auth/oauth2/register", {
        method: "POST",
      }),
    ])

    for (const response of responses) expect(response.status).toBe(404)
  })

  it("enables CORS only for an exact configured Web origin", async () => {
    const app = createApp()
    const environment = environmentWithCorsOrigin()
    const allowed = await app.fetch(
      new Request("http://local.test/.well-known/openid-configuration", {
        headers: { origin: allowedWebOrigin },
      }),
      environment,
    )
    const rejected = await app.fetch(
      new Request("http://local.test/.well-known/openid-configuration", {
        headers: { origin: `${allowedWebOrigin}.attacker.example` },
      }),
      environment,
    )

    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      allowedWebOrigin,
    )
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull()
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("serves explicit empty HEAD responses with metadata CORS", async () => {
    const app = createApp()
    const environment = environmentWithCorsOrigin()
    const metadataPaths = [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource/api",
    ]

    for (const path of metadataPaths) {
      const response = await app.fetch(
        new Request(`http://local.test${path}`, {
          headers: { origin: allowedWebOrigin },
          method: "HEAD",
        }),
        environment,
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(
        allowedWebOrigin,
      )
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
      expect(await response.text()).toBe("")

      const preflight = await app.fetch(
        new Request(`http://local.test${path}`, {
          headers: {
            "access-control-request-method": "HEAD",
            origin: allowedWebOrigin,
          },
          method: "OPTIONS",
        }),
        environment,
      )

      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        allowedWebOrigin,
      )
      expect(preflight.headers.get("access-control-allow-methods")).toBe(
        "GET,HEAD,OPTIONS",
      )
    }
  })

  it.each([
    ["/api/auth/jwks", "GET", "GET,OPTIONS"],
    ["/api/auth/oauth2/token", "POST", "POST,OPTIONS"],
    ["/api/auth/oauth2/revoke", "POST", "POST,OPTIONS"],
    ["/api/auth/oauth2/userinfo", "POST", "GET,POST,OPTIONS"],
  ])(
    "advertises only the enabled methods for %s",
    async (path, requestedMethod, expectedMethods) => {
      const response = await createApp().fetch(
        new Request(`http://local.test${path}`, {
          headers: {
            "access-control-request-method": requestedMethod,
            origin: allowedWebOrigin,
          },
          method: "OPTIONS",
        }),
        environmentWithCorsOrigin(),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-methods")).toBe(
        expectedMethods,
      )
    },
  )
})

describe("static OAuth clients", () => {
  it("keeps migration rows equal to the enabled static manifest subset", async () => {
    const clientRows = await env.DB.prepare(
      `SELECT clientId, applicationType, redirectUris, scopes,
              tokenEndpointAuthMethod, requirePKCE, disabled
       FROM oauthClient
       ORDER BY clientId`,
    ).all<{
      applicationType: string
      clientId: string
      disabled: number
      redirectUris: string
      requirePKCE: number
      scopes: string
      tokenEndpointAuthMethod: string
    }>()
    const links = await env.DB.prepare(
      `SELECT clientId, resourceId
       FROM oauthClientResource
       ORDER BY clientId, resourceId`,
    ).all<{ clientId: string; resourceId: string }>()
    const resource = await env.DB.prepare(
      `SELECT identifier, allowedScopes, refreshTokenTtl, signingAlgorithm,
              disabled
       FROM oauthResource
       WHERE identifier = ?1
       LIMIT 1`,
    )
      .bind(OAUTH_RESOURCE)
      .first<{
        allowedScopes: string
        disabled: number
        identifier: string
        refreshTokenTtl: number
        signingAlgorithm: string
      }>()

    expect(clientRows.results).toHaveLength(enabledOAuthClients.length)
    expect(clientRows.results.map(({ clientId }) => clientId)).toEqual(
      enabledOAuthClients.map(({ clientId }) => clientId),
    )
    expect(clientRows.results[0]).toMatchObject({
      applicationType: "native",
      disabled: 0,
      requirePKCE: 1,
      tokenEndpointAuthMethod: "none",
    })
    expect(JSON.parse(clientRows.results[0]?.redirectUris ?? "null")).toEqual(
      enabledOAuthClients[0]?.redirectUris,
    )
    expect(JSON.parse(clientRows.results[0]?.scopes ?? "null")).toEqual(
      enabledOAuthClients[0]?.scopes,
    )
    expect(links.results).toEqual([
      { clientId: "eruoo-desktop", resourceId: OAUTH_RESOURCE },
    ])
    expect(resource).toMatchObject({
      disabled: 0,
      identifier: OAUTH_RESOURCE,
      refreshTokenTtl: OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
      signingAlgorithm: "EdDSA",
    })
    expect(JSON.parse(resource?.allowedScopes ?? "null")).toEqual(oauthScopes)

    const disabledIds = oauthClients
      .filter(({ enabled }) => !enabled)
      .map(({ clientId }) => clientId)
    const disabledIdSet = new Set<string>(disabledIds)
    expect(
      clientRows.results.some(({ clientId }) => disabledIdSet.has(clientId)),
    ).toBe(false)
  })

  it("does not begin authorization for a disabled client ID", async () => {
    const response = await SELF.fetch(authorizationUrl("eruoo-web"), {
      redirect: "manual",
    })

    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client",
    })
  })
})

describe("canonical OAuth request inputs", () => {
  it("parses bounded URL-encoded OAuth forms without FormData", async () => {
    const values = await parseOAuthFormRequest(
      new Request("http://local.test/api/auth/oauth2/token", {
        body: "scope=api%3Aread&scope=api%3Awrite&client_id=eruoo-desktop",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        method: "POST",
      }),
    )

    expect(values?.getAll("scope")).toEqual(["api:read", "api:write"])
    expect(values?.get("client_id")).toBe("eruoo-desktop")
  })

  it.each([
    {
      body: "scope=api%ZZread",
      contentType: "application/x-www-form-urlencoded",
      name: "malformed percent encoding",
    },
    {
      body: "scope=api%3Aread",
      contentType: "application/json",
      name: "the wrong media type",
    },
  ])("rejects $name before OAuth processing", async ({ body, contentType }) => {
    const values = await parseOAuthFormRequest(
      new Request("http://local.test/api/auth/oauth2/token", {
        body,
        headers: { "content-type": contentType },
        method: "POST",
      }),
    )

    expect(values).toBeUndefined()
  })

  it.each([
    "openid profile api:read",
    "api:read api:write",
    "openid offline_access",
  ])("accepts canonical scope %s", (scope) => {
    expect(isCanonicalOAuthScope(scope)).toBe(true)
  })

  it.each([
    "",
    " api:read",
    "api:read ",
    "api:read  api:write",
    "api:read api:read",
    "profile api:read",
    "api:delete",
  ])("rejects non-canonical scope %s", (scope) => {
    expect(isCanonicalOAuthScope(scope)).toBe(false)
  })

  it.each([
    "grant_type",
    "client_id",
    "client_secret",
    "client_assertion",
    "client_assertion_type",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token",
  ])(
    "rejects duplicate token parameter %s before Better Auth",
    async (parameter) => {
      const body = new URLSearchParams({
        client_id: "eruoo-desktop",
        code: "synthetic-code",
        code_verifier: "A".repeat(43),
        grant_type: "authorization_code",
        refresh_token: "synthetic-refresh-token",
        redirect_uri: "http://127.0.0.1:49152/oauth/callback",
        resource: OAUTH_RESOURCE,
      })
      if (!body.has(parameter)) body.set(parameter, `first-${parameter}`)
      body.append(
        parameter,
        parameter === "grant_type" ? "refresh_token" : `second-${parameter}`,
      )

      const response = await SELF.fetch(
        "http://local.test/api/auth/oauth2/token",
        {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        },
      )

      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(response.json()).resolves.toEqual({
        error: "invalid_request",
        error_description: `${parameter} must not occur more than once`,
      })
    },
  )

  it.each([
    "client_id",
    "client_secret",
    "client_assertion",
    "client_assertion_type",
    "token",
    "token_type_hint",
  ])(
    "rejects duplicate revocation parameter %s before Better Auth",
    async (parameter) => {
      const body = new URLSearchParams({
        client_id: "eruoo-desktop",
        token: "synthetic-token",
        token_type_hint: "refresh_token",
      })
      if (!body.has(parameter)) body.set(parameter, `first-${parameter}`)
      body.append(parameter, `second-${parameter}`)

      const response = await SELF.fetch(
        "http://local.test/api/auth/oauth2/revoke",
        {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        },
      )

      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(response.json()).resolves.toEqual({
        error: "invalid_request",
        error_description: `${parameter} must not occur more than once`,
      })
    },
  )

  it("rejects duplicate authorization scopes before Better Auth", async () => {
    const response = await SELF.fetch(
      authorizationUrl("eruoo-desktop", "api:read api:read"),
      { redirect: "manual" },
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin).toBe("http://127.0.0.1:49152")
    expect(location.pathname).toBe("/oauth/callback")
    expect(location.searchParams.get("error")).toBe("invalid_scope")
    expect(location.searchParams.get("state")).toBe("synthetic-state")
    expect(location.searchParams.get("iss")).toBe(localIssuer)
  })

  it("accepts repeated identical resources as one authorization target", async () => {
    const url = authorizationUrl("eruoo-desktop")
    url.searchParams.append("resource", OAUTH_RESOURCE)

    const response = await SELF.fetch(url, { redirect: "manual" })

    expect(response.status).toBe(302)
    const location = new URL(
      response.headers.get("location") ?? "",
      localIssuer,
    )
    expect(location.origin).toBe(localIssuer)
    expect(location.pathname).toBe("/login")
    expect(location.searchParams.getAll("resource")).toEqual([
      OAUTH_RESOURCE,
      OAUTH_RESOURCE,
    ])
    expect(location.searchParams.get("sig")).toMatch(/\S+/)
  })

  it("rejects a repeated resource set containing an unknown target", async () => {
    const url = authorizationUrl("eruoo-desktop")
    url.searchParams.append("resource", `${OAUTH_RESOURCE}/unknown`)

    const response = await SELF.fetch(url, { redirect: "manual" })

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin).toBe("http://127.0.0.1:49152")
    expect(location.searchParams.get("error")).toBe("invalid_target")
    expect(location.searchParams.get("state")).toBe("synthetic-state")
  })

  it("passes repeated identical token resources to Better Auth", async () => {
    const body = new URLSearchParams({
      client_id: "eruoo-desktop",
      code: "synthetic-code",
      code_verifier: "A".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:49152/oauth/callback",
      resource: OAUTH_RESOURCE,
    })
    body.append("resource", OAUTH_RESOURCE)

    const response = await SELF.fetch(
      "http://local.test/api/auth/oauth2/token",
      {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
  })

  it("redirects a duplicate state error only after validating the redirect URI", async () => {
    const url = authorizationUrl("eruoo-desktop")
    url.searchParams.append("state", "ambiguous-state")
    const response = await SELF.fetch(url, { redirect: "manual" })

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin).toBe("http://127.0.0.1:49152")
    expect(location.searchParams.get("error")).toBe("invalid_request")
    expect(location.searchParams.has("state")).toBe(false)
    expect(location.searchParams.get("iss")).toBe(localIssuer)
  })

  it.each([
    "http://localhost:49152/oauth/callback",
    "http://127.1:49152/oauth/callback",
    "http://0177.0.0.1:49152/oauth/callback",
    "http://2130706433:49152/oauth/callback",
    "http://127.0.0.1.:49152/oauth/callback",
    "HTTP://127.0.0.1:49152/oauth/callback",
    "http://127.0.0.1:49152/oauth/./callback",
    "http://127.0.0.1:49152/oauth/%63allback",
    "http://127.0.0.1:49152/oauth/callback?next=ignored",
    "http://user@127.0.0.1:49152/oauth/callback",
    "http://127.0.0.1:49152/oauth/callback#fragment",
  ])("rejects a non-canonical loopback redirect %s", async (redirectUri) => {
    const url = authorizationUrl("eruoo-desktop")
    url.searchParams.set("redirect_uri", redirectUri)

    const response = await SELF.fetch(url, { redirect: "manual" })

    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
      error_description: "redirect_uri is not registered for this client",
    })
  })

  it("redirects temporary client-store failures after validating the redirect URI", async () => {
    await env.DB.prepare(
      "UPDATE oauthClient SET redirectUris = 'not-json' WHERE clientId = 'eruoo-desktop'",
    ).run()

    try {
      const response = await SELF.fetch(authorizationUrl("eruoo-desktop"), {
        redirect: "manual",
      })

      expect(response.status).toBe(302)
      const location = new URL(response.headers.get("location") ?? "")
      expect(location.origin).toBe("http://127.0.0.1:49152")
      expect(location.searchParams.get("error")).toBe("temporarily_unavailable")
      expect(location.searchParams.get("state")).toBe("synthetic-state")
      expect(location.searchParams.get("iss")).toBe(localIssuer)
    } finally {
      await env.DB.prepare(
        "UPDATE oauthClient SET redirectUris = ?1 WHERE clientId = 'eruoo-desktop'",
      )
        .bind(JSON.stringify(enabledOAuthClients[0]?.redirectUris))
        .run()
    }
  })

  it("requires the business resource during authorization-code exchange", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/oauth2/token",
      {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          code: "synthetic-code",
          code_verifier: "A".repeat(43),
          grant_type: "authorization_code",
          redirect_uri: "http://127.0.0.1:49152/oauth/callback",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_target",
    })
  })

  it("returns RFC 6749 invalid_request when the token body is too large", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/oauth2/token",
      {
        body: `grant_type=authorization_code&padding=${"a".repeat(1024 * 1024)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
      error_description: "the token request body exceeds the 1 MiB limit",
    })
  })
})
