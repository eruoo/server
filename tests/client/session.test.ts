import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

import { createSessionController } from "../../src/client/composables/session"
import { ApiError } from "../../src/client/lib/http"

const session = {
  session: { id: "session", userId: "owner" },
  user: { id: "owner", name: "Owner" },
}
beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("one Session controller", () => {
  it.each([false, true])(
    "handles the native GitHub redirect only for a current flow (invalidated: %s)",
    async (invalidated) => {
      window.history.replaceState(null, "", "/login")
      let finish!: (response: Response) => void
      let requested!: () => void
      const started = new Promise<void>((resolve) => (requested = resolve))
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        requested()
        return new Promise((resolve) => (finish = resolve))
      })
      const assign = vi
        .spyOn(window.location, "assign")
        .mockImplementation(() => undefined)
      const controller = createSessionController()
      const pending = controller.signIn()
      await started
      if (invalidated) controller.invalidate()
      finish(
        Response.json({
          redirect: true,
          url: "https://github.com/login/oauth/authorize?client_id=synthetic",
        }),
      )
      await pending
      expect(assign.mock.calls).toEqual(
        invalidated
          ? []
          : [["https://github.com/login/oauth/authorize?client_id=synthetic"]],
      )
      expect(window.location.pathname).toBe("/login")
    },
  )

  it("merges concurrent checks and avoids a second visibility check within 30 seconds", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(session))
    const controller = createSessionController()
    expect(controller.status.value).toBe("checking")
    await Promise.all([controller.refresh(), controller.refresh()])
    expect(controller.status.value).toBe("authenticated")
    await controller.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("keeps verified identity on 503 and does not pretend logout succeeded", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(session))
    const controller = createSessionController()
    await controller.refresh()
    fetch.mockResolvedValue(
      Response.json({ detail: "Unavailable" }, { status: 503 }),
    )
    await controller.refresh(true)
    expect(controller.status.value).toBe("unavailable")
    expect(controller.data.value?.user.id).toBe("owner")
  })

  it("does not let a late Session response undo logout", async () => {
    let finish!: (response: Response) => void
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("sign-out")
        ? Promise.resolve(Response.json({ success: true }))
        : new Promise((resolve) => {
            finish = resolve
          }),
    )
    const controller = createSessionController()
    const check = controller.refresh()
    await controller.signOut()
    finish(Response.json(session))
    await check
    expect(controller.status.value).toBe("anonymous")
    expect(controller.data.value).toBeNull()
  })

  it("does not let an in-flight cache read undo a trusted credential rejection", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(session))
    const controller = createSessionController()
    await controller.refresh()
    const rejectCredentials = controller.captureCredentialFailureHandler()
    let finish!: (response: Response) => void
    fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const check = controller.refresh(true)
    rejectCredentials(
      new ApiError(
        401,
        "https://auth.eruoo.me/problems/invalid-credential",
        "Session expired",
      ),
    )
    finish(Response.json(session))
    await check
    expect(controller.status.value).toBe("anonymous")
    expect(controller.data.value).toBeNull()
  })

  it("ignores an old operation's credential rejection after a new login cycle", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      Response.json(
        String(input).endsWith("/sign-out") ? { success: true } : session,
      ),
    )
    const controller = createSessionController()
    await controller.refresh()
    const rejectOldCredentials = controller.captureCredentialFailureHandler()
    await controller.signOut()
    await controller.refresh(true)
    rejectOldCredentials(
      new ApiError(
        401,
        "https://auth.eruoo.me/problems/authentication-required",
        "Old Session was missing",
      ),
    )
    expect(controller.status.value).toBe("authenticated")
    expect(controller.data.value?.user.id).toBe("owner")
  })

  it("preserves a new Session discovered after another window signs in", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(session))
    const controller = createSessionController()
    await controller.refresh()
    const rejectOldCredentials = controller.captureCredentialFailureHandler()
    fetch.mockResolvedValue(
      Response.json({
        ...session,
        session: { ...session.session, id: "new-session-from-another-window" },
      }),
    )
    await controller.refresh(true)
    rejectOldCredentials(
      new ApiError(
        401,
        "https://auth.eruoo.me/problems/invalid-credential",
        "Old Session expired",
      ),
    )
    expect(controller.status.value).toBe("authenticated")
    expect(controller.data.value?.session.id).toBe(
      "new-session-from-another-window",
    )
  })
})

it("skips brief visibility changes and coalesces checks after five minutes away", async () => {
  vi.useFakeTimers()
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(session))
  const controller = createSessionController()
  await controller.refresh()
  for (let i = 0; i < 10; i++) {
    await controller.visibilityChanged(false)
    vi.advanceTimersByTime(60_000)
    await controller.visibilityChanged(true)
  }
  expect(fetch).toHaveBeenCalledTimes(1)
  await controller.visibilityChanged(false)
  vi.advanceTimersByTime(5 * 60_000)
  await Promise.all([
    controller.visibilityChanged(true),
    controller.visibilityChanged(true),
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
})
