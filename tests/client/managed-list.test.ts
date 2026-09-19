import { mount } from "@vue/test-utils"
import { expect, it, vi } from "vitest"
import { defineComponent } from "vue"

import { useManagedList } from "../../src/client/composables/managed-list"
import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import { ApiError } from "../../src/client/lib/http"
function mountedList(read: (signal: AbortSignal) => Promise<string[]>) {
  let list!: ReturnType<typeof useManagedList<string>>
  const wrapper = mount(
    defineComponent({
      setup() {
        list = useManagedList(read)
        return () => null
      },
    }),
    {
      global: {
        provide: { [sessionKey as symbol]: createSessionController() },
      },
    },
  )
  return { list, wrapper }
}
it("keeps mutation success distinct from its one failed list refresh", async () => {
  const read = vi
    .fn<(signal: AbortSignal) => Promise<string[]>>()
    .mockRejectedValue(new Error("DB unavailable"))
  const { list, wrapper } = mountedList(read)
  const mutate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  expect(await list.mutate(mutate)).toBe(true)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(1)
  expect(list.message.value).toContain("操作已成功，列表未刷新")
  wrapper.unmount()
})
it("drops the previous scope's items and prompt on reset", async () => {
  const read = vi
    .fn<(signal: AbortSignal) => Promise<string[]>>()
    .mockResolvedValue(["kept"])
  const { list, wrapper } = mountedList(read)
  await list.load()
  await list.mutate(async () => {
    throw new ApiError(
      403,
      "/problems/recent-authentication-required",
      "reauthenticate",
    )
  })
  expect(list.items.value).toEqual(["kept"])
  expect(list.needsReauthentication.value).toBe(true)

  // A scope change must not leave the previous scope's data or prompt behind.
  list.reset()
  expect(list.items.value).toEqual([])
  expect(list.needsReauthentication.value).toBe(false)
  expect(list.message.value).toBe("")
  wrapper.unmount()
})

it("ignores a read that a reset replaced and recovers on the next load", async () => {
  let resolveStale!: (value: string[]) => void
  const read = vi
    .fn<(signal: AbortSignal) => Promise<string[]>>()
    .mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveStale = resolve
      }),
    )
    .mockResolvedValue(["fresh"])
  const { list, wrapper } = mountedList(read)
  const stale = list.load()
  list.reset()
  resolveStale(["stale"])
  await stale
  expect(list.items.value).toEqual([])

  await list.load()
  expect(list.items.value).toEqual(["fresh"])
  wrapper.unmount()
})
it("requires an explicit retry after recent-auth failure and ignores an unmounted result", async () => {
  const read = vi
    .fn<(signal: AbortSignal) => Promise<string[]>>()
    .mockResolvedValue(["secret-free metadata"])
  const { list, wrapper } = mountedList(read)
  await list.mutate(async () => {
    throw new ApiError(
      403,
      "/problems/recent-authentication-required",
      "reauthenticate",
    )
  })
  expect(list.needsReauthentication.value).toBe(true)
  expect(read).not.toHaveBeenCalled()
  let complete!: () => void
  const pending = list.mutate(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve
      }),
  )
  wrapper.unmount()
  complete()
  expect(await pending).toBe(false)
  expect(read).not.toHaveBeenCalled()
  expect(list.items.value).toEqual([])
})
