import { expect, it } from "vitest"

import {
  AI_AUTHORIZATION_STATE_LABELS,
  describeAiModelCapabilities,
  describeAiProtocols,
  readAiConnectionState,
  readAiModelCapabilities,
  readAiPollDelayMs,
} from "../../src/client/features/ai/ai-connections"

it("maps the durable status onto the four states design §9 requires", () => {
  expect(
    readAiConnectionState({ authorizationStatus: "connected", enabled: true }),
  ).toBe("authorized")
  expect(
    readAiConnectionState({
      authorizationStatus: "reauthentication_required",
      enabled: true,
    }),
  ).toBe("reauthentication-required")
  expect(
    readAiConnectionState({
      authorizationStatus: "never_authorized",
      enabled: true,
    }),
  ).toBe("never-authorized")
  expect(
    readAiConnectionState({ authorizationStatus: "connected", enabled: false }),
  ).toBe("disabled")
  expect(AI_AUTHORIZATION_STATE_LABELS.authorized).toBe("连接已授权")
  expect(AI_AUTHORIZATION_STATE_LABELS["reauthentication-required"]).toBe(
    "需要重新授权",
  )
})

it("reads the stored capability payload defensively", () => {
  expect(
    readAiModelCapabilities({
      reasoningEfforts: ["low", "high"],
      supportedInApi: true,
      visibility: "list",
    }),
  ).toEqual({
    reasoningEfforts: ["low", "high"],
    supportedInApi: true,
    visibility: "list",
  })
  expect(readAiModelCapabilities(null)).toEqual({
    reasoningEfforts: [],
    supportedInApi: false,
    visibility: null,
  })
  expect(readAiModelCapabilities({ reasoningEfforts: [1, "low"] })).toEqual({
    reasoningEfforts: ["low"],
    supportedInApi: false,
    visibility: null,
  })
  expect(
    describeAiModelCapabilities({
      reasoningEfforts: ["low"],
      supportedInApi: true,
      visibility: null,
    }),
  ).toBe("推理强度 low · API 可用")
})

it("describes the provider protocol capability", () => {
  expect(describeAiProtocols("responses-subset")).toBe("Responses（子集）")
  expect(describeAiProtocols("something-else")).toBe("something-else")
})

it("follows the server poll schedule, clamped to at least one second", () => {
  const now = 1_000_000
  expect(readAiPollDelayMs({ nextPollAt: now + 4_000 }, now)).toBe(4_000)
  // A stale or invalid schedule never makes the client poll faster than 1 s.
  expect(readAiPollDelayMs({ nextPollAt: now - 5_000 }, now)).toBe(1_000)
  expect(readAiPollDelayMs({ intervalMs: 7_500 }, now)).toBe(7_500)
  expect(readAiPollDelayMs({ intervalMs: 200 }, now)).toBe(1_000)
  expect(readAiPollDelayMs({}, now)).toBe(5_000)
  expect(readAiPollDelayMs({ intervalMs: Number.NaN }, now)).toBe(5_000)
})
