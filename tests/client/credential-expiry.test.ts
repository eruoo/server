import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"
import { defineComponent, h } from "vue"

import SessionBoundary from "../../src/client/components/auth/SessionBoundary.vue"
import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import ApiKeyPanel from "../../src/client/features/security/ApiKeyPanel.vue"

afterEach(() => vi.restoreAllMocks())
const identity = {
  session: { id: "session", userId: "owner" },
  user: { id: "owner", name: "Owner" },
}
const key = {
  id: "created-key-id",
  name: "probe",
  key: "eruoo_synthetic_key",
  start: "eruoo_",
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
}
function rejection(status: number, slug: string) {
  return Response.json(
    {
      type: `https://auth.eruoo.me/problems/${slug}`,
      status,
      detail: "Request rejected",
    },
    { status, headers: { "content-type": "application/problem+json" } },
  )
}
async function mountKeys(
  respond: (path: string) => Response | Promise<Response>,
) {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input).endsWith("/get-session")
        ? Response.json(identity)
        : respond(String(input)),
    )
  const session = createSessionController()
  await session.refresh()
  const wrapper = mount(
    defineComponent(
      () => () => h(SessionBoundary, null, { default: () => h(ApiKeyPanel) }),
    ),
    {
      global: {
        provide: { [sessionKey as symbol]: session },
        stubs: {
          ConfirmAction: {
            emits: ["confirm"],
            template:
              '<button class="revoke" @click="$emit(\'confirm\')">Revoke</button>',
          },
        },
      },
    },
  )
  await flushPromises()
  return { wrapper, session, fetch }
}

it.each(["initial-list", "mutation", "manual-list", "after-mutation"])(
  "clears private UI after a trusted credential rejection from %s",
  async (failureAt) => {
    let expired = failureAt === "initial-list"
    const { wrapper, session, fetch } = await mountKeys((path) => {
      if (path.endsWith("/create")) {
        if (failureAt === "after-mutation") expired = true
        return Response.json(key)
      }
      if (expired)
        return rejection(
          401,
          failureAt === "mutation"
            ? "invalid-credential"
            : "authentication-required",
        )
      return Response.json({ apiKeys: [key] })
    })
    try {
      if (failureAt !== "initial-list") {
        await wrapper.find("form").trigger("submit")
        await flushPromises()
        if (failureAt !== "after-mutation") {
          expired = true
          const action =
            failureAt === "mutation"
              ? wrapper.find(".revoke")
              : wrapper
                  .findAll("button")
                  .find((button) => button.text() === "刷新列表")!
          await action.trigger("click")
          await flushPromises()
        }
      }
      expect(session.status.value).toBe("anonymous")
      expect(session.data.value).toBeNull()
      expect(wrapper.text()).toContain("请先登录")
      expect(wrapper.find("form").exists()).toBe(false)
      expect(wrapper.find('[aria-label="完整密钥"]').exists()).toBe(false)
      expect(
        fetch.mock.calls.filter(([input]) =>
          String(input).endsWith("/get-session"),
        ),
      ).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  },
)

it.each([
  [401, "unclassified"],
  [403, "permission-denied"],
  [403, "recent-authentication-required"],
  [503, "service-unavailable"],
])(
  "preserves identity and the one-time key for %s %s",
  async (status, slug) => {
    const { wrapper, session } = await mountKeys((path) =>
      path.endsWith("/create")
        ? Response.json(key)
        : path.endsWith("/delete")
          ? rejection(status as number, slug as string)
          : Response.json({ apiKeys: [key] }),
    )
    try {
      await wrapper.find("form").trigger("submit")
      await flushPromises()
      await wrapper.find(".revoke").trigger("click")
      await flushPromises()
      expect(session.status.value).toBe("authenticated")
      expect(wrapper.find('[aria-label="完整密钥"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain("请先登录")
      expect(wrapper.text().includes("使用 Passkey 重新验证")).toBe(
        slug === "recent-authentication-required",
      )
    } finally {
      wrapper.unmount()
    }
  },
)
