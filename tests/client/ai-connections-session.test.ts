import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import AiConnectionsView from "../../src/client/views/AiConnectionsView.vue"

const connectionId = "11111111-1111-4111-8111-111111111111"
const savePath = `/api/ai/connections/${connectionId}/credential`
const refreshPath = `/api/ai/connections/${connectionId}/models/refresh`

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  sessionStorage.clear()
})

function rejection(status = 401, slug = "invalid-credential") {
  return Response.json(
    {
      type: `https://auth.eruoo.me/problems/${slug}`,
      status,
      detail: "Request rejected",
    },
    { status },
  )
}

async function mountConnections(
  responses: Record<string, () => Response | Promise<Response>>,
) {
  vi.useFakeTimers()
  let sessionId = "original-session"
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const path = String(input)
      if (responses[path]) return responses[path]()
      if (path === "/api/auth/get-session")
        return Response.json({
          session: { id: sessionId, userId: "owner" },
          user: { id: "owner", name: "Owner" },
        })
      if (path === "/api/ai/providers") return Response.json({ providers: [] })
      if (path === "/api/ai/connections")
        return Response.json({
          connections: [
            {
              id: connectionId,
              slug: "main",
              name: "Main",
              enabled: true,
              authorizationStatus: "never_authorized",
              providerType: "deepseek",
              credentialVersion: 0,
              permissionVersion: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              models: [],
            },
          ],
        })
      if (path === savePath) return Response.json({ saved: true })
      if (path === refreshPath) return Response.json({ modelCount: 0 })
      throw new Error(`Unexpected request: ${path}`)
    })
  const session = createSessionController()
  await session.refresh(true)
  const wrapper = mount(AiConnectionsView, {
    global: { provide: { [sessionKey as symbol]: session } },
  })
  await flushPromises()
  return {
    fetch,
    session,
    wrapper,
    async save() {
      const input = wrapper.get('input[type="password"]')
      await input.setValue("synthetic-deepseek-key")
      await input.element
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flushPromises()
    },
    async replaceSession() {
      sessionId = "replacement-session"
      await session.refresh(true)
      await flushPromises()
    },
  }
}

it.each(["save", "model-refresh", "provider", "list"] as const)(
  "returns to login after a trusted 401 from %s",
  async (failureAt) => {
    const path =
      failureAt === "save"
        ? savePath
        : failureAt === "model-refresh"
          ? refreshPath
          : failureAt === "provider"
            ? "/api/ai/providers"
            : "/api/ai/connections"
    const { session, wrapper, save } = await mountConnections({
      [path]: () => rejection(),
    })
    try {
      if (failureAt === "save" || failureAt === "model-refresh") await save()
      expect(session.status.value).toBe("anonymous")
      expect(wrapper.text()).toContain("请先登录")
      expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  },
)
it.each([
  [401, "unclassified"],
  [403, "permission-denied"],
  [503, "service-unavailable"],
  [503, "ai-reauthorization-required"],
  [429, "ai-upstream-quota-exceeded"],
] as const)("preserves owner login after %s %s", async (status, slug) => {
  const { session, wrapper, save } = await mountConnections({
    [refreshPath]: () => rejection(status, slug),
  })
  try {
    await save()
    expect(session.status.value).toBe("authenticated")
    expect(wrapper.text()).toContain("模型发现失败")
  } finally {
    wrapper.unmount()
  }
})
it.each(["replacement-session", "unmounted"] as const)(
  "ignores a late save rejection after %s",
  async (change) => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const { session, wrapper, save, replaceSession } = await mountConnections({
      [savePath]: () => pending,
    })
    await save()
    if (change === "replacement-session") await replaceSession()
    else wrapper.unmount()
    finish(rejection())
    await flushPromises()
    expect(session.status.value).toBe("authenticated")
    if (change !== "unmounted") wrapper.unmount()
  },
)
it("clears the entered key and never persists it in browser storage", async () => {
  const { wrapper, save, fetch } = await mountConnections({})
  try {
    await save()
    expect(
      (wrapper.get('input[type="password"]').element as HTMLInputElement).value,
    ).toBe("")
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(fetch.mock.calls.some(([path]) => path === savePath)).toBe(true)
    expect(fetch.mock.calls.some(([path]) => path === refreshPath)).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it("does not start discovery from a late save success in another owner session", async () => {
  let finish!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const { wrapper, save, replaceSession, fetch } = await mountConnections({
    [savePath]: () => pending,
  })
  try {
    await save()
    await replaceSession()
    finish(Response.json({ saved: true }))
    await flushPromises()
    expect(fetch.mock.calls.some(([path]) => path === refreshPath)).toBe(false)
  } finally {
    wrapper.unmount()
  }
})
