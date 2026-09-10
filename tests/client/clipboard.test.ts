import { expect, it, vi } from "vitest"

import { clipboardBusy, copyCredential } from "../../src/client/lib/clipboard"
it("does not allow a second panel's copy to race an unfinished clipboard write", async () => {
  let finish!: () => void
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  try {
    const first = copyCredential("synthetic-old-key")
    expect(clipboardBusy.value).toBe(true)
    await expect(copyCredential("synthetic-new-key")).rejects.toThrow(
      "上一次复制",
    )
    expect(write).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(clipboardBusy.value).toBe(false)
  } finally {
    write.mockRestore()
  }
})
