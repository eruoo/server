import { expect, test } from "@playwright/test"
import type { BrowserContext, Page } from "@playwright/test"

import {
  e2eBootstrapPath,
  e2eBootstrapToken,
  e2eCurrentSessionPath,
  e2eStaleSessionPath,
} from "./support"

interface E2ESessionState {
  id: string
  reauthenticatedAt: string
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function randomBase64Url(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )

  return encodeBase64Url(new Uint8Array(digest))
}

async function bootstrapOwner(context: BrowserContext): Promise<void> {
  const response = await context.request.post(e2eBootstrapPath, {
    headers: { "x-e2e-bootstrap-token": e2eBootstrapToken },
  })

  expect(response.status()).toBe(200)
  await expect(response).toBeOK()
  const body = (await response.json()) as {
    cookie?: Parameters<BrowserContext["addCookies"]>[0][number]
  }

  if (!body.cookie) {
    throw new Error("The E2E bootstrap did not return a Session cookie.")
  }

  await context.addCookies([body.cookie])
}

async function readE2ESessionState(
  context: BrowserContext,
  path: string,
  method: "GET" | "POST",
): Promise<E2ESessionState> {
  const response = await context.request.fetch(path, {
    headers: { "x-e2e-bootstrap-token": e2eBootstrapToken },
    method,
  })

  await expect(response).toBeOK()
  return (await response.json()) as E2ESessionState
}

async function installVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
) {
  const client = await context.newCDPSession(page)
  await client.send("WebAuthn.enable")
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        automaticPresenceSimulation: true,
        ctap2Version: "ctap2_1",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        protocol: "ctap2",
        transport: "internal",
      },
    },
  )

  return { authenticatorId, client }
}

test("the owner can choose a supported sign-in method", async ({
  context,
  page,
}) => {
  const rejectedBootstrap = await context.request.post(e2eBootstrapPath)
  expect(rejectedBootstrap.status()).toBe(404)
  expect(rejectedBootstrap.headers()["set-cookie"]).toBeUndefined()

  await bootstrapOwner(context)
  await context.clearCookies()
  await page.goto("/login")

  await expect(
    page.getByRole("heading", { name: "确认 owner 身份" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "使用 Passkey" })).toBeVisible()
  await expect(page.getByRole("button", { name: "使用 GitHub" })).toBeVisible()

  await page.goto("/login?error=access_denied")
  await expect(page.getByRole("alert")).toHaveText(
    "GitHub 登录未完成，请重试。",
  )
})

test("a persisted owner Session restores the SPA and logout revokes it", async ({
  context,
  page,
}) => {
  await bootstrapOwner(context)

  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "身份与访问状态" }),
  ).toBeVisible()
  await expect(page.getByText("已验证 · Synthetic E2E Owner")).toBeVisible()

  const sessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "eruoo.session_token",
  )
  expect(sessionCookie).toBeDefined()
  expect(sessionCookie?.httpOnly).toBe(true)
  expect(sessionCookie?.sameSite).toBe("Lax")

  await page.reload()
  await expect(page.getByText("已验证 · Synthetic E2E Owner")).toBeVisible()

  await page.getByRole("link", { name: "审计" }).click()
  const auditHeading = page.getByRole("heading", { name: "安全审计" })
  await expect(page).toHaveURL(/\/security\/audit-log$/)
  await expect(auditHeading).toBeFocused()

  await page.goto("/")
  await page.getByRole("button", { name: "退出" }).click()
  await expect(page).toHaveURL(/\/login$/)

  if (!sessionCookie) {
    throw new Error("The bootstrap Session cookie was not stored by Chromium.")
  }

  await context.addCookies([
    {
      domain: sessionCookie.domain,
      expires: Math.floor(Date.now() / 1000) + 60 * 60,
      httpOnly: true,
      name: sessionCookie.name,
      path: sessionCookie.path,
      sameSite: "Lax",
      secure: false,
      value: sessionCookie.value,
    },
  ])

  const revokedSessionResponse = await context.request.get(
    "/api/auth/get-session",
  )
  expect(revokedSessionResponse.status()).toBe(200)
  expect(await revokedSessionResponse.json()).toBeNull()

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
})

test("the owner can register, use, reauthenticate with, and delete a Passkey", async ({
  context,
  page,
  request,
}) => {
  const { authenticatorId, client } = await installVirtualAuthenticator(
    context,
    page,
  )

  try {
    await bootstrapOwner(context)
    await page.goto("/")

    await page.getByLabel("凭据名称").fill("Chromium Virtual Authenticator")
    const registrationResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/verify-registration"),
    )
    await page.getByRole("button", { name: "添加 Passkey" }).click()
    expect((await registrationResponse).ok()).toBe(true)
    await expect(page.getByText("Passkey 已添加。")).toBeVisible()
    await expect(page.getByText("Chromium Virtual Authenticator")).toBeVisible()

    await page.getByRole("button", { name: "退出" }).click()
    await expect(page).toHaveURL(/\/login$/)

    const verifier = randomBase64Url(48)
    const challenge = await createPkceChallenge(verifier)
    const oauthState = randomBase64Url(32)
    const nativeCallback = "http://127.0.0.1:49152/oauth/callback"
    await page.route(`${nativeCallback}**`, async (route) => {
      await route.fulfill({
        body: "<!doctype html><title>Native OAuth callback</title>",
        contentType: "text/html",
        status: 200,
      })
    })
    const authorizationUrl = new URL(
      "/api/auth/oauth2/authorize",
      "http://localhost:5173",
    )
    authorizationUrl.searchParams.set("client_id", "eruoo-desktop")
    authorizationUrl.searchParams.set("code_challenge", challenge)
    authorizationUrl.searchParams.set("code_challenge_method", "S256")
    authorizationUrl.searchParams.set("nonce", randomBase64Url(32))
    authorizationUrl.searchParams.set("redirect_uri", nativeCallback)
    authorizationUrl.searchParams.set("resource", "https://auth.eruoo.me/api")
    authorizationUrl.searchParams.set("response_type", "code")
    authorizationUrl.searchParams.set(
      "scope",
      "openid profile api:read api:write offline_access",
    )
    authorizationUrl.searchParams.set("state", oauthState)

    await page.goto(authorizationUrl.toString())
    await expect(page).toHaveURL(/\/login\?.*sig=/)
    const authenticationResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/verify-authentication"),
    )
    const authorizationCallback = page.waitForURL(
      (url) =>
        url.origin === "http://127.0.0.1:49152" &&
        url.pathname === "/oauth/callback",
    )
    await page.getByRole("button", { name: "使用 Passkey" }).click()
    expect((await authenticationResponse).ok()).toBe(true)
    await authorizationCallback
    const callbackUrl = new URL(page.url())
    const authorizationCode = callbackUrl.searchParams.get("code")
    expect(authorizationCode).toMatch(/\S+/)
    expect(callbackUrl.searchParams.get("iss")).toBe("http://localhost:5173")
    expect(callbackUrl.searchParams.get("state")).toBe(oauthState)

    if (!authorizationCode) {
      throw new Error("The native OAuth callback did not contain a code.")
    }

    const tokenResponse = await request.post("/api/auth/oauth2/token", {
      form: {
        client_id: "eruoo-desktop",
        code: authorizationCode,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: nativeCallback,
        resource: "https://auth.eruoo.me/api",
      },
    })
    const tokenBody: unknown = await tokenResponse.json()
    expect(tokenResponse.status(), JSON.stringify(tokenBody)).toBe(200)
    expect(tokenBody).toMatchObject({
      access_token: expect.stringMatching(/\S+/),
      refresh_token: expect.stringMatching(/\S+/),
      token_type: "Bearer",
    })

    await page.goto("/")
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText("已验证 · Synthetic E2E Owner")).toBeVisible()

    await page.getByRole("button", { name: "退出" }).click()
    await expect(page).toHaveURL(/\/login$/)
    const ordinaryAuthenticationResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/verify-authentication"),
    )
    await page.getByRole("button", { name: "使用 Passkey" }).click()
    expect((await ordinaryAuthenticationResponse).ok()).toBe(true)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText("已验证 · Synthetic E2E Owner")).toBeVisible()

    const staleSession = await readE2ESessionState(
      context,
      e2eStaleSessionPath,
      "POST",
    )
    const staleReauthenticatedAt = Date.parse(staleSession.reauthenticatedAt)
    expect(staleReauthenticatedAt).not.toBeNaN()
    expect(staleReauthenticatedAt).toBeLessThan(Date.now() - 15 * 60 * 1000)

    await page
      .getByRole("button", {
        name: "删除 Chromium Virtual Authenticator",
      })
      .click()
    const deletionResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/delete-passkey"),
    )
    await page.getByRole("button", { name: "确认删除" }).click()
    const deniedDeletionResponse = await deletionResponse
    expect(deniedDeletionResponse.status()).toBe(403)
    expect(await deniedDeletionResponse.json()).toMatchObject({
      status: 403,
      title: "Recent authentication required",
    })
    await expect(
      page.getByRole("heading", { name: "需要重新确认身份" }),
    ).toBeVisible()
    await expect(
      page.getByText("请先重新确认身份，再执行这项操作。"),
    ).toBeVisible()

    const reauthenticationStartedAt = Date.now()
    const reauthenticationResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/verify-authentication"),
    )
    await page.getByRole("button", { name: "使用 Passkey" }).click()
    expect((await reauthenticationResponse).ok()).toBe(true)
    await expect(
      page.getByText("身份已重新确认，请再次执行刚才的操作。"),
    ).toBeVisible()

    const freshSession = await readE2ESessionState(
      context,
      e2eCurrentSessionPath,
      "GET",
    )
    const freshReauthenticatedAt = Date.parse(freshSession.reauthenticatedAt)
    expect(freshReauthenticatedAt).not.toBeNaN()
    expect(freshSession.id).not.toBe(staleSession.id)
    expect(freshReauthenticatedAt).toBeGreaterThan(staleReauthenticatedAt)
    expect(freshReauthenticatedAt).toBeGreaterThanOrEqual(
      reauthenticationStartedAt - 1_000,
    )

    await page
      .getByRole("button", {
        name: "删除 Chromium Virtual Authenticator",
      })
      .click()
    const retriedDeletionResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/passkey/delete-passkey"),
    )
    await page.getByRole("button", { name: "确认删除" }).click()
    expect((await retriedDeletionResponse).ok()).toBe(true)
    await expect(page.getByText("Passkey 已删除。")).toBeVisible()
    await expect(page.getByText("尚未注册 Passkey。")).toBeVisible()
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId,
    })
    await client.send("WebAuthn.disable")
  }
})
