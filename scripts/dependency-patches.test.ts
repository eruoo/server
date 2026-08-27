import { readdir, readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { describe, expect, it } from "vitest"

const betterAuthCorePatchPath =
  "patches/@better-auth__core@1.7.0.patch" as const
const betterAuthApiKeyPatchPath =
  "patches/@better-auth__api-key@1.7.0.patch" as const
const betterAuthOAuthProviderPatchPath =
  "patches/@better-auth__oauth-provider@1.7.0.patch" as const
const betterAuthEntrypoints = [
  "@better-auth/api-key",
  "@better-auth/oauth-provider",
  "@better-auth/passkey",
  "better-auth",
] as const

describe("dependency compatibility patches", () => {
  it("documents every Better Auth patch in the upgrade checklist", async () => {
    const documentation = await readFile("docs/development.md", "utf8")

    expect(documentation).toContain("三份补丁")
    expect(documentation).toContain("@better-auth/core")
    expect(documentation).toContain("@better-auth/api-key")
    expect(documentation).toContain("@better-auth/oauth-provider")
  })

  it("keeps the Better Auth Workers AsyncLocalStorage workaround pinned", async () => {
    const [patch, workspace, lockfile, coreEntrypoints] = await Promise.all([
      readFile(betterAuthCorePatchPath, "utf8"),
      readFile("pnpm-workspace.yaml", "utf8"),
      readFile("pnpm-lock.yaml", "utf8"),
      Promise.all(
        betterAuthEntrypoints.map(async (entrypoint) => {
          const packageRequire = createRequire(import.meta.resolve(entrypoint))
          return realpath(packageRequire.resolve("@better-auth/core"))
        }),
      ),
    ])

    expect(patch).toContain(
      "globalAsyncLocalStorage ? Promise.resolve(globalAsyncLocalStorage)",
    )
    expect(patch).not.toContain(
      '+\tif ("AsyncLocalStorage" in globalThis) return',
    )
    expect(workspace).toContain(
      `"@better-auth/core@1.7.0": "${betterAuthCorePatchPath}"`,
    )
    const lockfilePatchHash = lockfile.match(
      /'@better-auth\/core@1\.7\.0': ([a-f0-9]{64})/,
    )?.[1]
    expect(lockfilePatchHash).toMatch(/^[a-f0-9]{64}$/)
    expect(
      new Set(
        [...lockfile.matchAll(/@better-auth\/core@(\d+\.\d+\.\d+)/g)].map(
          ([, version]) => version,
        ),
      ),
    ).toEqual(new Set(["1.7.0"]))
    expect(
      new Set(
        [
          ...lockfile.matchAll(
            /@better-auth\/core@1\.7\.0\(patch_hash=([a-f0-9]{64})/g,
          ),
        ].map(([, patchHash]) => patchHash),
      ),
    ).toEqual(new Set([lockfilePatchHash]))

    const uniqueCoreEntrypoints = new Set(coreEntrypoints)
    expect(uniqueCoreEntrypoints.size).toBe(1)

    const [coreEntrypoint] = uniqueCoreEntrypoints
    expect(coreEntrypoint).toBeDefined()
    if (coreEntrypoint === undefined) {
      throw new Error("The Better Auth Core entrypoint could not be resolved.")
    }
    const coreDirectory = path.resolve(path.dirname(coreEntrypoint), "..")
    const [coreManifest, installedAsyncHooks] = await Promise.all([
      readFile(path.join(coreDirectory, "package.json"), "utf8"),
      readFile(path.join(coreDirectory, "dist/async_hooks/index.mjs"), "utf8"),
    ])

    expect(JSON.parse(coreManifest)).toMatchObject({
      name: "@better-auth/core",
      version: "1.7.0",
    })
    expect(installedAsyncHooks).toContain(
      "globalAsyncLocalStorage ? Promise.resolve(globalAsyncLocalStorage)",
    )
    expect(installedAsyncHooks).not.toContain(
      'if ("AsyncLocalStorage" in globalThis)',
    )
  })

  it("keeps API key dependency failures observable to the Worker", async () => {
    const apiKeyRequire = createRequire(
      import.meta.resolve("@better-auth/api-key"),
    )
    const apiKeyEntrypoint = await realpath(
      apiKeyRequire.resolve("@better-auth/api-key"),
    )
    const apiKeyDirectory = path.resolve(path.dirname(apiKeyEntrypoint), "..")
    const [patch, workspace, lockfile, manifest, installedApiKey] =
      await Promise.all([
        readFile(betterAuthApiKeyPatchPath, "utf8"),
        readFile("pnpm-workspace.yaml", "utf8"),
        readFile("pnpm-lock.yaml", "utf8"),
        readFile(path.join(apiKeyDirectory, "package.json"), "utf8"),
        readFile(path.join(apiKeyDirectory, "dist/index.mjs"), "utf8"),
      ])

    expect(JSON.parse(manifest)).toMatchObject({
      name: "@better-auth/api-key",
      version: "1.7.0",
    })
    expect(patch).toContain("+\t\t\tthrow error;")
    expect(workspace).toContain(
      `"@better-auth/api-key@1.7.0": ${betterAuthApiKeyPatchPath}`,
    )

    const lockfilePatchHash = lockfile.match(
      /'@better-auth\/api-key@1\.7\.0': ([a-f0-9]{64})/,
    )?.[1]
    expect(lockfilePatchHash).toMatch(/^[a-f0-9]{64}$/)
    const installedPatchHashes = [
      ...lockfile.matchAll(
        /@better-auth\/api-key@1\.7\.0\(patch_hash=([a-f0-9]{64})/g,
      ),
    ].map(([, patchHash]) => patchHash)
    expect(installedPatchHashes.length).toBeGreaterThan(0)
    expect(new Set(installedPatchHashes)).toEqual(new Set([lockfilePatchHash]))

    const verificationFailureBoundary = installedApiKey.match(
      /ctx\.context\.logger\.error\("Failed to validate API key:", error\);[\s\S]*?\n\t\t}\n\t\tconst \{ key:/,
    )?.[0]
    expect(verificationFailureBoundary).toBeDefined()
    expect(verificationFailureBoundary).toContain(
      "if (isAPIError(error)) return ctx.json",
    )
    expect(verificationFailureBoundary).toContain("throw error;")
    expect(verificationFailureBoundary).not.toContain('code: "INVALID_API_KEY"')
  })

  it("keeps OAuth provider compatibility fixes pinned", async () => {
    const oauthProviderRequire = createRequire(
      import.meta.resolve("@better-auth/oauth-provider"),
    )
    const oauthProviderEntrypoint = await realpath(
      oauthProviderRequire.resolve("@better-auth/oauth-provider"),
    )
    const oauthProviderDirectory = path.resolve(
      path.dirname(oauthProviderEntrypoint),
      "..",
    )
    const distDirectory = path.join(oauthProviderDirectory, "dist")
    const [patch, workspace, lockfile, manifest, distFileNames] =
      await Promise.all([
        readFile(betterAuthOAuthProviderPatchPath, "utf8"),
        readFile("pnpm-workspace.yaml", "utf8"),
        readFile("pnpm-lock.yaml", "utf8"),
        readFile(path.join(oauthProviderDirectory, "package.json"), "utf8"),
        readdir(distDirectory),
      ])
    const installedDistribution = (
      await Promise.all(
        distFileNames
          .filter((fileName) => fileName.endsWith(".mjs"))
          .map((fileName) =>
            readFile(path.join(distDirectory, fileName), "utf8"),
          ),
      )
    ).join("\n")

    expect(JSON.parse(manifest)).toMatchObject({
      name: "@better-auth/oauth-provider",
      version: "1.7.0",
    })
    expect(patch).toContain(
      "async function invalidateRefreshFamily(ctx, clientId, userId, authorizationCodeId)",
    )
    expect(workspace).toContain(
      `"@better-auth/oauth-provider@1.7.0": "${betterAuthOAuthProviderPatchPath}"`,
    )

    const lockfilePatchHash = lockfile.match(
      /'@better-auth\/oauth-provider@1\.7\.0': ([a-f0-9]{64})/,
    )?.[1]
    expect(lockfilePatchHash).toMatch(/^[a-f0-9]{64}$/)
    expect(
      new Set(
        [
          ...lockfile.matchAll(
            /@better-auth\/oauth-provider@1\.7\.0\(patch_hash=([a-f0-9]{64})/g,
          ),
        ].map(([, patchHash]) => patchHash),
      ),
    ).toEqual(new Set([lockfilePatchHash]))

    const familyInvalidation = installedDistribution.match(
      /async function invalidateRefreshFamily[\s\S]*?\n}\nasync function revokeTokensIssuedForAuthorizationCode/,
    )?.[0]
    expect(familyInvalidation).toBeDefined()
    expect(
      familyInvalidation?.match(/field: "authorizationCodeId"/g),
    ).toHaveLength(2)
    expect(installedDistribution).toContain(
      "invalidateRefreshFamily(ctx, client_id, refreshToken.userId, refreshToken.authorizationCodeId)",
    )
    expect(
      installedDistribution.match(
        /invalidateRefreshFamily\(ctx, clientId, refreshToken\.userId, refreshToken\.authorizationCodeId\)/g,
      ),
    ).toHaveLength(2)
    const revocationEndpoint = installedDistribution.match(
      /async function revokeEndpoint\(ctx, opts\) \{[\s\S]*?\n}\n\/\/#endregion/,
    )?.[0]
    const accessTokenRevocationAttempt =
      "const revokeAsAccessToken = () => revokeAccessToken(ctx, opts, client.clientId, token);"
    const refreshTokenRevocationAttempt =
      "const revokeAsRefreshToken = async () => revokeRefreshToken(ctx, opts, (await decodeRefreshToken(opts, token)).token, client.clientId);"
    const revocationAttemptOrder =
      'const revocationAttempts = token_type_hint === "refresh_token" ? [revokeAsRefreshToken, revokeAsAccessToken] : [revokeAsAccessToken, revokeAsRefreshToken];'
    const revocationFallbackBoundary = [
      'if (error.body?.error === "unsupported_token_type") throw error;',
      'if (error.status === "BAD_REQUEST") continue;',
      "throw error;",
    ].join("\n\t\t\t\t")
    expect(revocationEndpoint).toBeDefined()
    expect(patch).toContain(`+\t${accessTokenRevocationAttempt}`)
    expect(patch).toContain(`+\t${refreshTokenRevocationAttempt}`)
    expect(patch).toContain(`+\t${revocationAttemptOrder}`)
    expect(patch).toContain(
      revocationFallbackBoundary
        .split("\n")
        .map((line) => `+\t\t\t\t${line.trimStart()}`)
        .join("\n"),
    )
    expect(revocationEndpoint).toContain(accessTokenRevocationAttempt)
    expect(revocationEndpoint).toContain(refreshTokenRevocationAttempt)
    expect(revocationEndpoint).toContain(revocationAttemptOrder)
    expect(revocationEndpoint).toContain(revocationFallbackBoundary)
    expect(revocationEndpoint).not.toContain(
      'token_type_hint === void 0 || token_type_hint === "access_token"',
    )
    expect(revocationEndpoint).not.toContain(
      'token_type_hint === void 0 || token_type_hint === "refresh_token"',
    )
    expect(patch).toContain('if (error.status === "BAD_REQUEST") return null;')
    expect(patch).not.toContain(
      '-\t\t\tif (error.status === "BAD_REQUEST") return null;',
    )
    expect(installedDistribution).toContain(
      'if (error.status === "BAD_REQUEST") return null;',
    )
    expect(installedDistribution).not.toContain(
      'if (error.name === "BAD_REQUEST") return null;',
    )
    expect(patch).toContain("+\t\t\t\tawait revokeEndpoint(ctx, opts);")
    expect(patch).toContain("+\t\t\t\treturn new Response(null);")
    expect(installedDistribution).toContain(
      "await revokeEndpoint(ctx, opts);\n\t\t\t\treturn new Response(null);",
    )
    expect(installedDistribution).not.toContain(
      "return revokeEndpoint(ctx, opts);",
    )
    const oauthContinuationAuthenticationPaths =
      'const oauthContinuationAuthenticationPaths = /* @__PURE__ */ new Set(["/sign-in/social", "/passkey/verify-authentication", "/oauth2/consent", "/oauth2/continue"]);'
    const oauthContinuationMatcher =
      "return oauthContinuationAuthenticationPaths.has(ctx.path) && ctx.body?.oauth_query;"
    expect(patch).toContain(`+${oauthContinuationAuthenticationPaths}`)
    expect(patch).toContain(`+\t\t\t\t\t${oauthContinuationMatcher}`)
    expect(installedDistribution).toContain(
      oauthContinuationAuthenticationPaths,
    )
    expect(installedDistribution).toContain(oauthContinuationMatcher)
    expect(installedDistribution).not.toContain("return ctx.body?.oauth_query;")
    expect(patch).toContain(
      '+const oauthContinuationAuthenticationPaths = /* @__PURE__ */ new Set(["/api/auth/sign-in/social", "/api/auth/passkey/verify-authentication"]);',
    )
    expect(patch).toContain('+\t\t\t\tif (ctx.method !== "POST") return;')
    expect(patch).toContain(
      "+\t\t\t\tif (!oauthContinuationAuthenticationPaths.has(pathname)) return;",
    )
  })

  it("limits signed OAuth continuation injection to login requests", async () => {
    const onRequest = oauthProviderClient().fetchPlugins[0]?.hooks.onRequest
    expect(onRequest).toBeDefined()
    if (!onRequest) {
      throw new Error("The OAuth provider request hook is unavailable.")
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          search:
            "?client_id=eruoo-desktop&ba_param=client_id&sig=synthetic-signature&error=unsigned-error",
        },
      },
    })

    const requestBodyAfterHook = async (pathname: string, method = "POST") => {
      const requestContext = {
        body: JSON.stringify({ marker: pathname }),
        headers: new Headers({ "content-type": "application/json" }),
        method,
        signal: new AbortController().signal,
        url: new URL(pathname, "https://eruoo.me"),
      }

      await onRequest(requestContext)

      return JSON.parse(requestContext.body) as Record<string, unknown>
    }

    try {
      for (const pathname of [
        "/api/auth/sign-in/social",
        "/api/auth/passkey/verify-authentication",
      ]) {
        const body = await requestBodyAfterHook(pathname)
        expect(new URLSearchParams(String(body["oauth_query"]))).toEqual(
          new URLSearchParams(
            "client_id=eruoo-desktop&ba_param=client_id&sig=synthetic-signature",
          ),
        )
      }

      for (const pathname of [
        "/api/auth/sign-out",
        "/api/auth/api-key/create",
        "/api/auth/api-key/delete",
        "/api/auth/passkey/verify-registration",
        "/api/auth/passkey/delete-passkey",
        "/api/auth/passkey/update-passkey",
        "/other/sign-in/social",
        "/other/passkey/verify-authentication",
      ]) {
        await expect(requestBodyAfterHook(pathname)).resolves.toEqual({
          marker: pathname,
        })
      }
      await expect(
        requestBodyAfterHook("/api/auth/sign-in/social", "GET"),
      ).resolves.toEqual({ marker: "/api/auth/sign-in/social" })
    } finally {
      Reflect.deleteProperty(globalThis, "window")
    }
  })
})
