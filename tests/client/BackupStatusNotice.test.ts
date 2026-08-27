import type { DatabaseBackupStatus } from "@client/features/security/backup-status-service"
import BackupStatusNotice from "@client/features/security/BackupStatusNotice.vue"
import { ApiResponseError } from "@client/lib/api-response"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

const backupStatusMocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<DatabaseBackupStatus>>(),
}))

vi.mock("@client/features/security/backup-status-service", () => ({
  backupStatusService: {
    get: backupStatusMocks.get,
  },
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { component: { template: "<div />" }, path: "/" },
      { component: { template: "<div />" }, path: "/login" },
    ],
  })
}

async function mountNotice() {
  const router = createTestRouter()
  await router.push("/")
  const wrapper = mount(BackupStatusNotice, {
    global: { plugins: [router] },
  })

  await flushPromises()

  return { router, wrapper }
}

function problemError(
  status: number,
  slug: string,
  detail: string,
): ApiResponseError {
  return new ApiResponseError(detail, {
    detail,
    requestId: "synthetic-request-id",
    status,
    title: "Synthetic failure",
    type: `https://auth.eruoo.me/problems/${slug}`,
  })
}

describe("BackupStatusNotice", () => {
  beforeEach(() => {
    backupStatusMocks.get.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<DatabaseBackupStatus>([
    {
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    },
    {
      errorCode: null,
      lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
      lastSuccessAt: Date.parse("2026-08-21T03:04:05.000Z"),
      status: "ok",
    },
  ])("stays hidden when backup status is $status", async (status) => {
    backupStatusMocks.get.mockResolvedValue(status)

    const { wrapper } = await mountNotice()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it("shows a persistent, redacted failure with an Asia/Shanghai time", async () => {
    backupStatusMocks.get.mockResolvedValue({
      errorCode: "backup_upload_failed",
      lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
      lastSuccessAt: null,
      status: "failed",
    })

    const { wrapper } = await mountNotice()
    const alert = wrapper.get('[role="alert"]')

    expect(alert.text()).toContain("数据库备份失败")
    expect(alert.text()).toContain("2026年8月21日")
    expect(alert.text()).toContain("11:04:05")
    expect(alert.text()).toContain("Asia/Shanghai")
    expect(alert.text()).not.toContain("backup_upload_failed")
    expect(alert.get("button").text()).toBe("重新检查")
    expect(alert.get("time").attributes("datetime")).toBe(
      "2026-08-21T03:04:05.000Z",
    )

    wrapper.unmount()
  })

  it("clears a failed reminder after a manual recheck succeeds", async () => {
    backupStatusMocks.get
      .mockResolvedValueOnce({
        errorCode: "backup_upload_failed",
        lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
        lastSuccessAt: null,
        status: "failed",
      })
      .mockResolvedValueOnce({
        errorCode: null,
        lastAttemptAt: Date.parse("2026-08-22T03:04:05.000Z"),
        lastSuccessAt: Date.parse("2026-08-22T03:04:05.000Z"),
        status: "ok",
      })

    const { wrapper } = await mountNotice()

    await wrapper.get("button").trigger("click")
    await flushPromises()

    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it("keeps the last confirmed failure when a recheck is unavailable", async () => {
    backupStatusMocks.get
      .mockResolvedValueOnce({
        errorCode: "backup_upload_failed",
        lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
        lastSuccessAt: null,
        status: "failed",
      })
      .mockRejectedValueOnce(
        problemError(503, "service-unavailable", "private service detail"),
      )

    const { wrapper } = await mountNotice()

    await wrapper.get("button").trigger("click")
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain("数据库备份失败")
    expect(alert.text()).toContain("2026年8月21日")
    expect(alert.text()).toContain("最近一次状态检查失败")
    expect(alert.text()).not.toContain("无法确认备份状态")
    expect(alert.text()).not.toContain("private service detail")

    wrapper.unmount()
  })

  it("automatically clears a failed reminder while the page stays visible", async () => {
    vi.useFakeTimers()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    backupStatusMocks.get
      .mockResolvedValueOnce({
        errorCode: "backup_upload_failed",
        lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
        lastSuccessAt: null,
        status: "failed",
      })
      .mockResolvedValueOnce({
        errorCode: null,
        lastAttemptAt: Date.parse("2026-08-22T03:04:05.000Z"),
        lastSuccessAt: Date.parse("2026-08-22T03:04:05.000Z"),
        status: "ok",
      })

    const { wrapper } = await mountNotice()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await flushPromises()

    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it("does not schedule another recheck after an in-flight request is unmounted", async () => {
    vi.useFakeTimers()
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    let resolveRecheck: ((status: DatabaseBackupStatus) => void) | undefined
    backupStatusMocks.get
      .mockResolvedValueOnce({
        errorCode: "backup_upload_failed",
        lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
        lastSuccessAt: null,
        status: "failed",
      })
      .mockImplementationOnce(
        () =>
          new Promise<DatabaseBackupStatus>((resolve) => {
            resolveRecheck = resolve
          }),
      )

    const { wrapper } = await mountNotice()

    await wrapper.get("button").trigger("click")
    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
    wrapper.unmount()

    resolveRecheck?.({
      errorCode: "backup_upload_failed",
      lastAttemptAt: Date.parse("2026-08-22T03:04:05.000Z"),
      lastSuccessAt: null,
      status: "failed",
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
  })

  it("revalidates on a foreground return after the five-minute minimum interval", async () => {
    let now = Date.parse("2026-08-21T03:05:00.000Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    backupStatusMocks.get
      .mockResolvedValueOnce({
        errorCode: "backup_upload_failed",
        lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
        lastSuccessAt: null,
        status: "failed",
      })
      .mockResolvedValueOnce({
        errorCode: null,
        lastAttemptAt: Date.parse("2026-08-21T03:06:05.000Z"),
        lastSuccessAt: Date.parse("2026-08-21T03:06:05.000Z"),
        status: "ok",
      })

    const { wrapper } = await mountNotice()

    window.dispatchEvent(new Event("focus"))
    await flushPromises()
    expect(backupStatusMocks.get).toHaveBeenCalledOnce()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)

    now += 5 * 60 * 1000
    document.dispatchEvent(new Event("visibilitychange"))
    await flushPromises()

    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it.each([
    new Error("private network failure"),
    new ApiResponseError("private contract failure"),
    problemError(500, "internal-error", "private database detail"),
    problemError(503, "service-unavailable", "private service detail"),
  ])("redacts an unreadable status and offers a retry", async (error) => {
    backupStatusMocks.get.mockRejectedValue(error)

    const { wrapper } = await mountNotice()
    const alert = wrapper.get('[role="alert"]')

    expect(alert.text()).toContain("无法确认备份状态")
    expect(alert.get("button").text()).toBe("重试")
    expect(alert.text()).not.toContain(error.message)

    wrapper.unmount()
  })

  it("retries an unreadable status without leaving stale error content", async () => {
    backupStatusMocks.get
      .mockRejectedValueOnce(new Error("private network failure"))
      .mockResolvedValueOnce({
        errorCode: null,
        lastAttemptAt: 10,
        lastSuccessAt: 10,
        status: "ok",
      })

    const { wrapper } = await mountNotice()

    await wrapper.get("button").trigger("click")
    await flushPromises()

    expect(backupStatusMocks.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it("offers login only for a canonical authentication Problem", async () => {
    backupStatusMocks.get.mockRejectedValue(
      problemError(
        401,
        "authentication-required",
        "private expired Session detail",
      ),
    )

    const { router, wrapper } = await mountNotice()
    const alert = wrapper.get('[role="alert"]')

    expect(alert.text()).toContain("需要重新登录")
    expect(alert.text()).not.toContain("private expired Session detail")

    await alert.get("button").trigger("click")
    await flushPromises()

    expect(router.currentRoute.value.path).toBe("/login")

    wrapper.unmount()
  })

  it("keeps a retry action when an authentication type carries a 503 status", async () => {
    backupStatusMocks.get.mockRejectedValue(
      problemError(
        503,
        "authentication-required",
        "private mismatched Problem detail",
      ),
    )

    const { wrapper } = await mountNotice()
    const alert = wrapper.get('[role="alert"]')

    expect(alert.text()).toContain("无法确认备份状态")
    expect(alert.get("button").text()).toBe("重试")
    expect(alert.text()).not.toContain("需要重新登录")
    expect(alert.text()).not.toContain("private mismatched Problem detail")

    wrapper.unmount()
  })
})
