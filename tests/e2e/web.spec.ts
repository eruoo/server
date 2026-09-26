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
// Runs before the Passkey test below, which logs out and deletes the session
// row this cookie depends on. The AI reads hit the real worker routes.
test("signed-in AI deep links mount the management panels", async ({
  page,
  context,
}) => {
  await context.addCookies([cookie])
  await page.goto("/security/ai-connections")
  await expect(page.getByRole("heading", { name: "AI 连接" })).toBeVisible()
  await expect(page.getByRole("button", { name: "新建连接" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "请先登录" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "刷新列表" })).toBeVisible()

  await page.goto("/security/ai-invocations")
  await expect(page.getByRole("heading", { name: "调用记录" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "请先登录" })).toHaveCount(0)
  await expect(page.getByText("最近 30 天没有调用记录。")).toBeVisible()
})

// Also depends on the pre-seeded session row and runs before the Passkey
// logout test. Both panels hit the real worker routes without route mocks.
test("signed-in authorized apps and backup status read the real routes", async ({
  page,
  context,
}) => {
  await context.addCookies([cookie])
  await page.goto("/security/authorized-apps")
  await expect(page.getByRole("heading", { name: "已授权应用" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "请先登录" })).toHaveCount(0)
  await expect(page.getByText("尚未授权").first()).toBeVisible()
  await expect(page.getByText("尚未开放").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "刷新列表" })).toBeVisible()

  await page.getByRole("button", { name: "备份状态", exact: true }).click()
  await expect(page.getByText("尚无备份记录。")).toBeVisible()
})

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
  await page.getByRole("button", { name: "备份状态", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "数据库备份" })).toBeVisible()
  await expect(page.getByText("尚无备份记录。")).toBeVisible()
  await page.getByRole("button", { name: "关闭", exact: true }).click()
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
  await page.getByRole("link", { name: "Passkey", exact: true }).click()
  await expect(page.getByRole("button", { name: "账号菜单" })).toBeVisible()
  await expect(page).toHaveURL(/\/security\/passkeys$/)
  finishConsent()
  await delivered
  await expect(page.getByRole("button", { name: "账号菜单" })).toBeVisible()
  await expect(page).toHaveURL(/\/security\/passkeys$/)
  await page.unroute("**/api/auth/oauth2/consent")
  await page.getByRole("button", { name: "账号菜单" }).click()
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click()
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await page.getByRole("button", { name: "使用 Passkey 登录" }).click()
  await expect(page.getByRole("button", { name: "账号菜单" })).toBeVisible()
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
  await page.getByRole("link", { name: "Passkey", exact: true }).click()
  await page.getByRole("button", { name: "账号菜单" }).click()
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click()
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
  await page.getByRole("link", { name: "Passkey", exact: true }).click()
  await expect(page).toHaveURL(/\/security\/passkeys$/)
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
  await expect(page).toHaveURL(/\/security\/passkeys$/)
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

  await context.clearCookies()
  const hakoCallback = "https://hako.eruoo.me/api/auth/callback"
  await page.route(`${hakoCallback}**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<h1>Hako callback received</h1>",
    }),
  )
  query.set("client_id", "hako-web")
  query.set("redirect_uri", hakoCallback)
  query.set("scope", "openid profile")
  query.set("state", "hako-passkey-state")
  query.set("nonce", "hako-passkey-nonce")
  await page.goto(`/api/auth/oauth2/authorize?${query}`)
  await page.getByRole("button", { name: "使用 Passkey 登录" }).click()
  await expect(
    page.getByRole("heading", { name: "Hako callback received" }),
  ).toBeVisible()
  expect(new URL(page.url()).searchParams.get("state")).toBe(
    "hako-passkey-state",
  )
  expect(new URL(page.url()).searchParams.get("code")).toBeTruthy()
})
test("anonymous deep links never mount protected controls", async ({
  page,
}) => {
  await page.goto("/security/api-keys")
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await expect(page.getByRole("button", { name: "创建密钥" })).toHaveCount(0)
  // The AI deep links mount the same boundary and no AI controls.
  for (const path of ["/security/ai-connections", "/security/ai-invocations"]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
    await expect(page.getByRole("button", { name: "新建连接" })).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "开始设备授权" }),
    ).toHaveCount(0)
  }
  await expect(page.getByRole("button", { name: "账号菜单" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "备份状态", exact: true }),
  ).toHaveCount(0)
  const appearance = page.getByRole("button", { name: /^外观：/ })
  await expect(appearance).toHaveCount(1)
  await expect(appearance).toBeVisible()
  await appearance.click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await appearance.click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 375)
})

test("global controls preserve appearance preferences and gate backup access", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        user: { id: "owner", name: "测试账号", email: "owner@example.invalid" },
        session: { id: "session", userId: "owner" },
      },
    }),
  )
  await page.route("**/api/auth/passkey/list-user-passkeys", (route) =>
    route.fulfill({ json: [] }),
  )
  let backupReads = 0
  let expired = false
  await page.route("**/api/security/backup-status", (route) => {
    backupReads++
    return route.fulfill(
      expired
        ? {
            status: 401,
            json: {
              type: "https://auth.eruoo.me/problems/authentication-required",
              status: 401,
            },
          }
        : {
            json: {
              status: "never-run",
              errorCode: null,
              lastAttemptAt: null,
              lastSuccessAt: null,
            },
          },
    )
  })
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 320, height: 812 })
  await page.goto("/account")
  await expect(page).toHaveURL(/\/security\/passkeys$/)
  await expect(
    page.getByRole("heading", { name: "Passkey", exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole("navigation")
      .getByRole("link", { name: "账号", exact: true }),
  ).toHaveCount(0)
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320)
  expect(backupReads).toBe(0)

  const account = page.getByRole("button", { name: "账号菜单" })
  await account.click()
  await expect(page.getByRole("menu", { name: "账号菜单" })).toContainText(
    "owner@example.invalid",
  )
  await expect(
    page.getByRole("menuitem", { name: "退出登录", exact: true }),
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(account).toBeFocused()

  const appearance = page.getByRole("button", { name: /^外观：/ })
  await expect(appearance).toHaveCount(1)
  await expect(appearance).toHaveAttribute(
    "aria-label",
    "外观：跟随系统；切换为浅色",
  )
  await appearance.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expect(appearance).toHaveAttribute(
    "aria-label",
    "外观：浅色；切换为深色",
  )
  await page.keyboard.press("Space")
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(appearance).toHaveAttribute(
    "aria-label",
    "外观：深色；切换为跟随系统",
  )
  await expect(appearance).toBeFocused()
  await expect(page.getByRole("menu", { name: "外观设置" })).toHaveCount(0)
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(appearance).toHaveAttribute(
    "aria-label",
    "外观：深色；切换为跟随系统",
  )
  await appearance.click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system")
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  await appearance.click()
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

  const backup = page.getByRole("button", { name: "备份状态", exact: true })
  await backup.click()
  const dialog = page.getByRole("dialog", { name: "数据库备份" })
  await expect(dialog).toContainText("尚无备份记录。")
  expect(backupReads).toBe(1)
  await dialog
    .getByRole("button", { name: "刷新备份状态", exact: true })
    .click()
  await expect.poll(() => backupReads).toBe(2)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(backup).toBeFocused()
  await backup.click()
  await expect(dialog).toContainText("尚无备份记录。")
  expect(backupReads).toBe(3)
  expired = true
  await dialog
    .getByRole("button", { name: "刷新备份状态", exact: true })
    .click()
  await expect(dialog).toHaveCount(0)
  await expect(account).toHaveCount(0)
  await expect(backup).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
  await expect(appearance).toBeVisible()
})

test("account menu keeps failed sign-out visible and allows retry outside protected pages", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        user: { id: "owner", name: "测试账号", email: "owner@example.invalid" },
        session: { id: "session", userId: "owner" },
      },
    }),
  )
  let finish!: () => void
  const pending = new Promise<void>((resolve) => (finish = resolve))
  let attempts = 0
  await page.route("**/api/auth/sign-out", async (route) => {
    attempts++
    if (attempts === 1) {
      await pending
      await route.fulfill({ status: 500, json: { message: "Unavailable" } })
    } else await route.fulfill({ json: { success: true } })
  })
  await page.goto("/not-found")
  await page.getByRole("button", { name: "账号菜单" }).click()
  const menu = page.getByRole("menu", { name: "账号菜单" })
  await menu.getByRole("menuitem", { name: "退出登录", exact: true }).click()
  await expect(
    menu.getByRole("menuitem", { name: "正在退出…", exact: true }),
  ).toBeDisabled()
  finish()
  await expect(menu.getByRole("alert")).toHaveText("未确认退出，请重试退出。")
  await expect(menu).toContainText("owner@example.invalid")
  await menu.getByRole("menuitem", { name: "退出登录", exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole("button", { name: "账号菜单" })).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "页面不存在", exact: true }),
  ).toBeVisible()
  expect(attempts).toBe(2)
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
    await page.getByRole("link", { name: "Passkey", exact: true }).click()
    await expect(page).toHaveURL(/\/security\/passkeys$/)
    const completed = page.waitForResponse("**/api/auth/sign-in/social")
    finish()
    await (await completed).finished()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    await expect(page).toHaveURL(/\/security\/passkeys$/)
    await expect(page.getByRole("heading", { name: "请先登录" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "使用 GitHub 登录" }),
    ).toBeEnabled()
  })
}
