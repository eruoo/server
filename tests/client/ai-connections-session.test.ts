import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import AiConnectionsView from "../../src/client/views/AiConnectionsView.vue"

const connectionId = "11111111-1111-4111-8111-111111111111"
const authorizationId = "22222222-2222-4222-8222-222222222222"
const startPath = `/api/ai/connections/${connectionId}/authorizations`
const statusPath = `/api/ai/authorizations/${authorizationId}`
const pollPath = `${statusPath}/poll`
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
              providerType: "openai-codex",
              upstreamAccount: "未绑定账号",
              credentialExpiresAt: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              models: [],
            },
          ],
        })
      if (path === startPath)
        return Response.json({
          authorizationId,
          expiresAt: Date.now() + 900_000,
          intervalMs: 5_000,
          userCode: "TEST-CODE",
          verificationUrl: "https://auth.openai.com/codex/device",
        })
      if (path === statusPath || path === pollPath)
        return Response.json({
          status: "pending",
          expiresAt: Date.now() + 900_000,
          nextPollAt: Date.now() + 5_000,
        })
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
    async start() {
      const authorize = wrapper
        .findAll("button")
        .find((button) => button.text().includes("开始设备授权"))
      expect(authorize).toBeDefined()
      await authorize!.trigger("click")
      await flushPromises()
      expect(wrapper.find('input[aria-label="设备授权代码"]').exists()).toBe(
        true,
      )
    },
    async replaceSession() {
      sessionId = "replacement-session"
      await session.refresh(true)
      await flushPromises()
    },
  }
}

it.each(["poll", "read-back", "resume", "model-refresh", "provider"] as const)(
  "returns to login and stops authorization after a trusted 401 from %s",
  async (failureAt) => {
    const responses: Record<string, () => Response> = {}
    if (failureAt === "poll") {
      responses[pollPath] = () => rejection()
      // A cached read must not conceal the poll's authoritative refusal.
      responses[statusPath] = () => Response.json({ status: "cancelled" })
    } else if (failureAt === "read-back") {
      responses[pollPath] = () => rejection(503, "service-unavailable")
      responses[statusPath] = () => rejection()
    } else if (failureAt === "resume") {
      sessionStorage.setItem(
        "ai-pending-authorization",
        JSON.stringify({
          authorizationId,
          connectionId,
        }),
      )
      responses[statusPath] = () => rejection()
    } else if (failureAt === "model-refresh") {
      responses[pollPath] = () => Response.json({ status: "completed" })
      responses[refreshPath] = () => rejection()
    } else {
      responses["/api/ai/providers"] = () => rejection()
    }
    const { fetch, session, wrapper, start } = await mountConnections(responses)
    try {
      if (failureAt !== "resume" && failureAt !== "provider") {
        await start()
        await vi.advanceTimersByTimeAsync(5_000)
        await flushPromises()
      }
      expect(session.status.value).toBe("anonymous")
      expect(wrapper.text()).toContain("请先登录")
      expect(wrapper.find('input[aria-label="设备授权代码"]').exists()).toBe(
        false,
      )
      expect(sessionStorage.getItem("ai-pending-authorization")).toBeNull()
      expect(fetch.mock.calls.some(([path]) => path === statusPath)).toBe(
        failureAt === "read-back" || failureAt === "resume",
      )
      const requestCount = fetch.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetch).toHaveBeenCalledTimes(requestCount)
    } finally {
      wrapper.unmount()
    }
  },
)

it.each([
  [401, "unclassified"],
  [403, "permission-denied"],
  [503, "service-unavailable"],
] as const)(
  "preserves login after a poll returns %s %s",
  async (status, slug) => {
    const { session, wrapper, start } = await mountConnections({
      [pollPath]: () => rejection(status, slug),
    })
    try {
      await start()
      await vi.advanceTimersByTimeAsync(5_000)
      await flushPromises()
      expect(session.status.value).toBe("authenticated")
      expect(wrapper.text()).toContain("AI 连接")
      expect(wrapper.text()).not.toContain("请先登录")
    } finally {
      wrapper.unmount()
    }
  },
)

it.each(["replacement-session", "unmounted"] as const)(
  "ignores a late poll credential rejection after %s",
  async (change) => {
    let rejectPoll!: (response: Response) => void
    const pendingPoll = new Promise<Response>((resolve) => {
      rejectPoll = resolve
    })
    const { fetch, session, wrapper, start, replaceSession } =
      await mountConnections({
        [pollPath]: () => pendingPoll,
        [statusPath]: () => Response.json({ status: "cancelled" }),
      })
    try {
      await start()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetch.mock.calls.some(([path]) => path === pollPath)).toBe(true)
      if (change === "replacement-session") await replaceSession()
      else wrapper.unmount()
      rejectPoll(rejection())
      await flushPromises()
      expect(session.status.value).toBe("authenticated")
      expect(session.data.value?.session.id).toBe(
        change === "replacement-session"
          ? "replacement-session"
          : "original-session",
      )
    } finally {
      if (change !== "unmounted") wrapper.unmount()
    }
  },
)
