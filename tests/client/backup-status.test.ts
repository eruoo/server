import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import BackupStatus from "../../src/client/components/security/BackupStatus.vue"
import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"

afterEach(() => vi.restoreAllMocks())

it("cancels a dismissed backup read and ignores its late credential rejection", async () => {
  let finish!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/get-session"))
      return Response.json({
        user: { id: "owner", name: "Owner" },
        session: { id: "session", userId: "owner" },
      })
    signal = init?.signal
    return new Promise((resolve) => (finish = resolve))
  })
  const session = createSessionController()
  await session.refresh()
  const wrapper = mount(BackupStatus, {
    global: { provide: { [sessionKey as symbol]: session } },
  })
  await flushPromises()
  expect(signal?.aborted).toBe(false)
  wrapper.unmount()
  expect(signal?.aborted).toBe(true)
  finish(
    Response.json(
      {
        type: "https://auth.eruoo.me/problems/authentication-required",
        status: 401,
      },
      { status: 401 },
    ),
  )
  await flushPromises()
  expect(session.status.value).toBe("authenticated")
  expect(session.data.value?.session.id).toBe("session")
})
