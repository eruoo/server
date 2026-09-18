import { afterEach, expect, it, vi } from "vitest"

import {
  createApiKey,
  listApiKeys,
  removeApiKey,
  renameApiKey,
} from "../../src/client/features/security/api-keys"

afterEach(() => vi.restoreAllMocks())

it("scopes api key management calls to the explicit default profile", async () => {
  const calls: { url: string; method: string; body?: string }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    calls.push({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    if (url.includes("/api-key/list")) return Response.json({ apiKeys: [] })
    if (url.includes("/api-key/create"))
      return Response.json({
        id: "created",
        key: "eruoo_secret",
        name: "probe",
      })
    return Response.json({ success: true })
  })

  await listApiKeys(new AbortController().signal)
  await renameApiKey("key-id", "renamed")
  await removeApiKey("key-id")
  const created = await createApiKey("probe", 30)

  expect(created).toMatchObject({ id: "created", key: "eruoo_secret" })
  expect(calls[0]?.method).toBe("GET")
  expect(
    new URL(calls[0]!.url, "http://local.test").searchParams.get("configId"),
  ).toBe("default")
  expect(JSON.parse(calls[1]!.body!)).toEqual({
    keyId: "key-id",
    name: "renamed",
    configId: "default",
  })
  expect(JSON.parse(calls[2]!.body!)).toEqual({
    keyId: "key-id",
    configId: "default",
  })
  // 旧调用方省略新增参数时行为不变：创建仍只发送 name 与 expiresIn。
  expect(JSON.parse(calls[3]!.body!)).toEqual({
    name: "probe",
    expiresIn: 30 * 86400,
  })
})
