import { expect, test } from "@playwright/test"
import type { BrowserContext } from "@playwright/test"

import { e2eBootstrapPath, e2eBootstrapToken } from "./support"

interface E2EBootstrapPayload {
  cookie: Parameters<BrowserContext["addCookies"]>[0][number]
  fixtures: {
    auditEvent: {
      id: string
      occurredAt: number
    }
    oauthClientId: "eruoo-desktop"
  }
}

async function bootstrapOwner(
  context: BrowserContext,
): Promise<E2EBootstrapPayload> {
  const response = await context.request.post(e2eBootstrapPath, {
    headers: { "x-e2e-bootstrap-token": e2eBootstrapToken },
  })

  await expect(response).toBeOK()
  const payload = (await response.json()) as E2EBootstrapPayload
  await context.addCookies([payload.cookie])
  return payload
}

function shanghaiTimestampParts(timestamp: number) {
  const shanghaiTime = new Date(timestamp + 8 * 60 * 60 * 1000)

  return {
    date: `${shanghaiTime.getUTCFullYear()}年${shanghaiTime.getUTCMonth() + 1}月${shanghaiTime.getUTCDate()}日`,
    time: `${String(shanghaiTime.getUTCHours()).padStart(2, "0")}:${String(shanghaiTime.getUTCMinutes()).padStart(2, "0")}:${String(shanghaiTime.getUTCSeconds()).padStart(2, "0")}`,
  }
}

test("the owner can inspect a security audit event in Asia/Shanghai time", async ({
  context,
  page,
}) => {
  const { fixtures } = await bootstrapOwner(context)

  await page.goto("/security/audit-log")

  await expect(page.getByRole("heading", { name: "安全审计" })).toBeFocused()
  const auditEvent = page
    .getByRole("list", { name: "安全审计事件" })
    .getByRole("listitem")
    .filter({ hasText: fixtures.auditEvent.id })

  await expect(
    auditEvent.getByRole("heading", { name: "GitHub 登录" }),
  ).toBeVisible()
  await expect(auditEvent.getByText("成功", { exact: true })).toBeVisible()

  const occurredAt = auditEvent.locator("time")
  const shanghaiParts = shanghaiTimestampParts(fixtures.auditEvent.occurredAt)
  await expect(occurredAt).toHaveAttribute(
    "datetime",
    new Date(fixtures.auditEvent.occurredAt).toISOString(),
  )
  await expect(occurredAt).toContainText(shanghaiParts.date)
  await expect(occurredAt).toContainText(`${shanghaiParts.time} · UTC+8`)
})

test("the owner can confirm and persistently revoke the Desktop authorization", async ({
  context,
  page,
}) => {
  const { fixtures } = await bootstrapOwner(context)

  await page.goto("/security/authorized-apps")
  await expect(page.getByRole("heading", { name: "已授权应用" })).toBeFocused()

  const desktopApplication = page
    .getByRole("list", { name: "应用授权状态" })
    .getByRole("listitem")
    .filter({ hasText: "eruoo Desktop" })

  await expect(
    desktopApplication.getByText("已授权", { exact: true }),
  ).toBeVisible()
  await expect(desktopApplication.getByText("离线访问：已授权")).toBeVisible()
  await expect(
    desktopApplication.getByText("offline_access", { exact: true }),
  ).toBeVisible()

  await desktopApplication
    .getByRole("button", { name: "撤销 eruoo Desktop 授权" })
    .click()
  await expect(
    page.getByRole("heading", {
      name: "撤销 eruoo Desktop 的长期授权？",
    }),
  ).toBeVisible()

  const revocationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/api/oauth/authorizations/${fixtures.oauthClientId}`,
  )
  await page.getByRole("button", { name: "确认撤销" }).click()
  expect((await revocationResponse).ok()).toBe(true)

  await expect(
    page.getByText("已撤销 eruoo Desktop 的长期授权。"),
  ).toBeVisible()
  await expect(
    desktopApplication.getByText("未授权", { exact: true }),
  ).toBeVisible()
  await expect(desktopApplication.getByText("离线访问：未授权")).toBeVisible()
  await expect(
    desktopApplication.getByRole("button", {
      name: "撤销 eruoo Desktop 授权",
    }),
  ).toHaveCount(0)

  await page.reload()
  await expect(
    desktopApplication.getByText("未授权", { exact: true }),
  ).toBeVisible()
  await expect(desktopApplication.getByText("离线访问：未授权")).toBeVisible()
})

test("theme selection switches among system, dark, and light and survives reloads", async ({
  context,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" })
  await bootstrapOwner(context)
  await page.goto("/")

  const root = page.locator("html")
  const systemTheme = page.getByRole("button", { name: "跟随系统主题" })
  const lightTheme = page.getByRole("button", { name: "使用浅色主题" })
  const darkTheme = page.getByRole("button", { name: "使用深色主题" })

  await expect(root).toHaveClass(/\bbrutal\b/)
  await expect(root).not.toHaveClass(/\bdark\b/)
  await expect(systemTheme).toHaveAttribute("aria-pressed", "true")

  await darkTheme.click()
  await expect(root).toHaveClass(/\bdark\b/)
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(root).toHaveClass(/\bdark\b/)
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true")

  await lightTheme.click()
  await expect(root).not.toHaveClass(/\bdark\b/)
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(root).not.toHaveClass(/\bdark\b/)
  await expect(lightTheme).toHaveAttribute("aria-pressed", "true")

  await page.emulateMedia({ colorScheme: "dark" })
  await expect(root).not.toHaveClass(/\bdark\b/)
  await systemTheme.click()
  await expect(root).toHaveClass(/\bdark\b/)
  await expect(systemTheme).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(root).toHaveClass(/\bdark\b/)
  await expect(systemTheme).toHaveAttribute("aria-pressed", "true")
})
