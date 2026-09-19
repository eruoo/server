import { flushPromises, mount } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import {
  describeAiInvocationError,
  listAiInvocations,
  readUsageTotalTokens,
} from "../../src/client/features/ai/ai-invocations"
import AiInvocationsPanel from "../../src/client/features/ai/AiInvocationsPanel.vue"

vi.mock("../../src/client/features/ai/ai-invocations", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/client/features/ai/ai-invocations")
  >("../../src/client/features/ai/ai-invocations")
  return {
    ...actual,
    listAiInvocations: vi.fn<typeof actual.listAiInvocations>(),
  }
})

const record = {
  apiKeyId: "key-1",
  connectionId: "11111111-1111-1111-1111-111111111111",
  deadlineAt: 1,
  effectiveStatus: "succeeded",
  endedAt: 2,
  errorCode: null,
  leaseExpiresAt: 3,
  requestId: "33333333-3333-3333-3333-333333333333",
  startedAt: 1,
  status: "succeeded",
  upstreamModelId: "gpt-test",
  upstreamRequestId: "upstream-1",
  usage: JSON.stringify({ total_tokens: 42 }),
}

function mountPanel() {
  return mount(AiInvocationsPanel, {
    global: {
      provide: { [sessionKey as symbol]: createSessionController() },
    },
  })
}

it("renders recorded metadata and pages with the cursor", async () => {
  const failed = {
    ...record,
    effectiveStatus: "failed",
    errorCode: "ai-upstream-unavailable",
    requestId: "44444444-4444-4444-4444-444444444444",
    upstreamRequestId: null,
    usage: null,
  }
  vi.mocked(listAiInvocations)
    .mockResolvedValueOnce({
      nextCursor: { requestId: record.requestId, startedAt: record.startedAt },
      records: [record],
    } as never)
    .mockResolvedValueOnce({
      nextCursor: null,
      records: [failed],
    } as never)

  const wrapper = mountPanel()
  await flushPromises()
  expect(wrapper.text()).toContain("succeeded")
  expect(wrapper.text()).toContain("用量 42 tokens")
  expect(wrapper.text()).toContain("上游 upstream-1")

  const more = wrapper
    .findAll("button")
    .find((button) => button.text().includes("加载更多"))
  expect(more).toBeDefined()
  await more?.trigger("click")
  await flushPromises()
  // The second page is requested with the first page's cursor and appended.
  expect(listAiInvocations).toHaveBeenLastCalledWith(expect.anything(), {
    requestId: record.requestId,
    startedAt: record.startedAt,
  })
  expect(wrapper.text()).toContain("ai-upstream-unavailable")
  expect(wrapper.text()).toContain("用量未知")
  expect(
    wrapper
      .findAll("button")
      .some((button) => button.text().includes("加载更多")),
  ).toBe(false)
})

it("reads only well-formed usage totals", () => {
  expect(readUsageTotalTokens(JSON.stringify({ total_tokens: 7 }))).toBe(7)
  expect(readUsageTotalTokens(JSON.stringify({ total_tokens: "7" }))).toBeNull()
  expect(readUsageTotalTokens("not json")).toBeNull()
  expect(readUsageTotalTokens(null)).toBeNull()
})

it("labels the controlled errors the operator must tell apart", () => {
  expect(describeAiInvocationError("ai-upstream-quota-exceeded")).toBe(
    "额度暂不可用（ai-upstream-quota-exceeded）",
  )
  expect(describeAiInvocationError("ai-reauthorization-required")).toBe(
    "需要重新授权（ai-reauthorization-required）",
  )
  expect(describeAiInvocationError("something-new")).toBe(
    "错误码 something-new",
  )
  expect(describeAiInvocationError(null)).toBe("无受控错误码")
})
