import { expect, it } from "vitest"

import {
  AI_AUTHORIZATION_STATE_LABELS,
  describeAiModelCapabilities,
  describeAiProtocols,
  readAiConnectionState,
  readAiModelCapabilities,
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
  expect(AI_AUTHORIZATION_STATE_LABELS.authorized).toBe("Key 已配置")
  expect(AI_AUTHORIZATION_STATE_LABELS["reauthentication-required"]).toBe(
    "需要配置有效 Key",
  )
})

it("reads the stored capability payload defensively", () => {
  expect(
    readAiModelCapabilities({
      reasoningEfforts: ["low", "high"],
      supportedInApi: true,
      vision: false,
    }),
  ).toEqual({
    reasoningEfforts: ["low", "high"],
    supportedInApi: true,
    vision: false,
  })
  expect(readAiModelCapabilities(null)).toEqual({
    reasoningEfforts: [],
    supportedInApi: false,
    vision: false,
  })
  expect(readAiModelCapabilities({ reasoningEfforts: [1, "low"] })).toEqual({
    reasoningEfforts: ["low"],
    supportedInApi: false,
    vision: false,
  })
  expect(
    describeAiModelCapabilities({
      reasoningEfforts: ["low"],
      supportedInApi: true,
      vision: false,
    }),
  ).toBe("文本 · effort low · 默认 max")
})

it("describes the provider protocol capability", () => {
  expect(describeAiProtocols("responses-subset")).toBe("Responses（子集）")
  expect(describeAiProtocols("something-else")).toBe("something-else")
})
