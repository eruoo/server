import { createHash, createHmac } from "node:crypto"

import { expect, test } from "@playwright/test"
const signature = createHmac(
  "sha256",
  "e2e-authentication-secret-at-least-32-characters",
)
  .update("e2e-session-token")
  .digest("base64")
const cookie = {
  name: "eruoo.session_token",
  value: encodeURIComponent(`e2e-session-token.${signature}`),
  domain: "localhost",
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
}
test("Web management and complete Passkey registration/login/logout", async ({
  page,
  context,
}) => {
  await context.addCookies([cookie])
  const authenticator = await context.newCDPSession(page)
  await authenticator.send("WebAuthn.enable")
  await authenticator.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto("/security/passkeys")
  await expect(
    page.getByRole("heading", { name: "Passkey", exact: true }),
  ).toBeVisible()
  await page.getByLabel("名称", { exact: true }).fill("测试设备")
  await page.getByRole("button", { name: "添加 Passkey", exact: true }).click()
  await expect(page.getByText("操作已成功。")).toBeVisible()
  await page.getByRole("link", { name: "API Key", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "API Key", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "刷新列表" })).toBeEnabled()
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("浏览器测试")
  await expect(
    page.getByRole("textbox", { name: "名称", exact: true }),
  ).toHaveValue("浏览器测试")
  await page.getByRole("button", { name: "创建密钥" }).click()
  await expect(page.getByLabel("完整密钥")).toHaveValue(/^eruoo_/)
  await page.getByRole("button", { name: "撤销", exact: true }).click()
  await page.getByRole("button", { name: "确认撤销", exact: true }).click()
  await expect(page.getByLabel("完整密钥")).toHaveCount(0)
  await expect(page.locator(".credential-list li")).toHaveCount(0)
  await page.getByRole("link", { name: "账号", exact: true }).click()
  await page.getByRole("button", { name: "查看备份状态" }).click()
  await expect(page.getByText("尚无备份记录。")).toBeVisible()
  const consentQuery = new URLSearchParams({
    client_id: "eruoo-desktop",
    scope: "openid offline_access",
    exp: String(Math.floor(Date.now() / 1000) + 120),
    ba_iat: String(Date.now()),
    sig: "browser-fixture",
  })
  for (const name of ["ba_param", "exp", "ba_iat", "client_id", "scope"])
    consentQuery.append("ba_param", name)
  let finishConsent!: () => void
  const consentResponse = new Promise<void>((resolve) => {
    finishConsent = resolve
  })
  let responseDelivered!: () => void
  const delivered = new Promise<void>((resolve) => {
    responseDelivered = resolve
  })
  await page.route("**/api/auth/oauth2/consent", async (route) => {
    await consentResponse
    await route.fulfill({
      json: {
        redirect: true,
        url: "http://127.0.0.1:49152/oauth/callback?code=late",
      },
    })
    responseDelivered()
  })
  await page.goto(`/oauth/consent?${consentQuery}`)
  const consentStarted = page.waitForRequest("**/api/auth/oauth2/consent")
  await page.getByRole("button", { name: "允许授权", exact: true }).click()
  await consentStarted
  await page.getByRole("link", { name: "账号", exact: true }).click()
  await expect(page.getByRole("button", { name: "退出当前登录" })).toBeVisible()
  await expect(page).toHaveURL(/\/account$/)
  finishConsent()
  await delivered
  await expect(page.getByRole("button", { name: "退出当前登录" })).toBeVisible()
  await expect(page).toHaveURL(/\/account$/)
  await page.unroute("**/api/auth/oauth2/consent")
  await page.getByRole("button", { name: "退出当前登录" }).click()
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await page.getByRole("button", { name: "使用 Passkey 登录" }).click()
  await expect(page.getByRole("button", { name: "退出当前登录" })).toBeVisible()
  await page.getByRole("link", { name: "API 文档", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "API 文档", exact: true }),
  ).toBeVisible()
  await page
    .getByRole("link", { name: "/api/status HTTP Method: GET", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Ask AI", exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "/api/status", exact: true }),
  ).toBeVisible()
  await page.getByRole("link", { name: "安全审计", exact: true }).click()
  await expect(page.getByRole("table")).toBeVisible()
  await page.screenshot({
    path: "test-results/web-management.png",
    fullPage: true,
  })
  await page.getByRole("link", { name: "账号", exact: true }).click()
  await page.getByRole("button", { name: "退出当前登录" }).click()
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await page.route(/^http:\/\/127\.0\.0\.1:49152\/oauth\/callback/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<h1>OAuth callback received</h1>",
    }),
  )
  const query = new URLSearchParams({
    client_id: "eruoo-desktop",
    redirect_uri: "http://127.0.0.1:49152/oauth/callback",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update("e2e-verifier".repeat(8))
      .digest("base64url"),
    scope: "openid profile api:read offline_access",
    resource: "https://auth.eruoo.me/api",
    state: "browser-continuation-state",
  })

  let finishPasskey!: () => void
  const passkeyResponse = new Promise<void>((resolve) => {
    finishPasskey = resolve
  })
  await page.route(
    "**/api/auth/passkey/verify-authentication",
    async (route) => {
      await passkeyResponse
      await route.continue()
    },
  )
  await page.goto(`/api/auth/oauth2/authorize?${query}`)
  const passkeyStarted = page.waitForRequest(
    "**/api/auth/passkey/verify-authentication",
  )
  await page.getByRole("button", { name: "使用 Passkey 登录" }).click()
  await passkeyStarted
  await page.getByRole("link", { name: "账号", exact: true }).click()
  await expect(page).toHaveURL(/\/account$/)
  const passkeyFinished = page.waitForResponse(
    "**/api/auth/passkey/verify-authentication",
  )
  finishPasskey()
  const latePasskey = await passkeyFinished
  expect(latePasskey.status()).toBe(200)
  expect(await latePasskey.json()).toMatchObject({ redirect: true })
  await latePasskey.finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await page.unroute("**/api/auth/passkey/verify-authentication")
  await context.clearCookies()

  await page.goto(`/api/auth/oauth2/authorize?${query}`)
  await page.getByRole("button", { name: "使用 Passkey 登录" }).click()
  await expect(
    page.getByRole("heading", { name: "OAuth callback received" }),
  ).toBeVisible()
  expect(new URL(page.url()).searchParams.get("state")).toBe(
    "browser-continuation-state",
  )
  expect(new URL(page.url()).searchParams.get("code")).toBeTruthy()
})
test("anonymous deep links never mount protected controls", async ({
  page,
}) => {
  await page.goto("/security/api-keys")
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await expect(page.getByRole("button", { name: "创建密钥" })).toHaveCount(0)
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 375)
})

for (const outcome of ["success", "invalid_signature"] as const) {
  test(`leaving a GitHub login ignores its late ${outcome} response`, async ({
    page,
  }) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => (finish = resolve))
    await page.route("https://github.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Unexpected stale navigation</h1>",
      }),
    )
    await page.route("**/api/auth/sign-in/social", async (route) => {
      await pending
      await route.fulfill(
        outcome === "success"
          ? {
              json: {
                redirect: true,
                url: "https://github.com/login/oauth/authorize?client_id=synthetic",
              },
            }
          : { status: 400, json: { code: "invalid_signature" } },
      )
    })
    await page.goto("/login")
    const started = page.waitForRequest("**/api/auth/sign-in/social")
    await page.getByRole("button", { name: "使用 GitHub 登录" }).click()
    await started
    await page.getByRole("link", { name: "账号", exact: true }).click()
    await expect(page).toHaveURL(/\/account$/)
    const completed = page.waitForResponse("**/api/auth/sign-in/social")
    finish()
    await (await completed).finished()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "使用 GitHub 登录" }),
    ).toBeEnabled()
  })
}
