import { createRoute, z } from "@hono/zod-openapi"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"

import {
  API_KEY_AI_CONFIG_ID,
  API_KEY_AI_PURPOSE,
  API_KEY_DEFAULT_CONFIG_ID,
  API_KEY_STATUS_PURPOSE,
} from "../../shared/api-key"
import {
  buildAiKeyPermissions,
  resolveAiModelSelection,
} from "../ai/model-authorization"
import { problem, problemSchema } from "../http/response"
import type { AppBindings, OwnerSession } from "../http/types"
import { duplicateTopLevelJsonKeys } from "./json-duplicate-keys"
import {
  authRateLimitBucketKey,
  consumeAuthRateLimit,
  trustedRateLimitIp,
} from "./persistent-rate-limit"
import { getRequestAuth } from "./session"

type ApiKeyManagementOperation = "create" | "delete" | "get" | "list" | "update"

/**
 * 应用侧 API Key 网关的操作表。owner/recent-auth、Origin、凭证载体、
 * 入口限流和读期限仍由 /api/auth/* 统一处理；本模块只校验字段、配置档
 * 与资源归属，再调用插件服务端 API。
 */
const apiKeyManagementOperations: ReadonlyMap<
  string,
  ApiKeyManagementOperation
> = new Map([
  ["POST /api/auth/api-key/create", "create"],
  ["GET /api/auth/api-key/list", "list"],
  ["GET /api/auth/api-key/get", "get"],
  ["POST /api/auth/api-key/update", "update"],
  ["POST /api/auth/api-key/delete", "delete"],
])

export function isApiKeyManagementOperation(
  method: string,
  path: string,
): boolean {
  return apiKeyManagementOperations.has(`${method} ${path}`)
}

/** 当前开放的应用侧配置档；未知档拒绝，不交给插件回退到默认档。 */
const apiKeyConfigIdSchema = z
  .enum([API_KEY_DEFAULT_CONFIG_ID, API_KEY_AI_CONFIG_ID])
  .meta({ description: "API key configuration profile." })

const apiKeyNameSchema = z
  .string()
  .min(1)
  .meta({ description: "Display name of the API key." })

const expiresInSchema = z
  .int()
  .min(24 * 60 * 60)
  .max(365 * 24 * 60 * 60)
  .meta({ description: "Lifetime in seconds, between 1 and 365 days." })

const createApiKeyBodySchema = z
  .object({
    name: apiKeyNameSchema,
    expiresIn: expiresInSchema.optional(),
    connectionId: z.string().min(1).optional().meta({
      description:
        "Connection UUID. Required together with modelIds for AI grants.",
    }),
    modelIds: z.array(z.string().min(1)).min(1).max(200).optional().meta({
      description:
        "Native upstream model IDs inside the selected connection. Required for the ai profile; rejected for the default profile.",
    }),
    purpose: z
      .enum([API_KEY_STATUS_PURPOSE, API_KEY_AI_PURPOSE])
      .optional()
      .meta({
        description:
          "Usage selector. Omitted or `status` maps to the default profile; `ai` maps to the ai profile.",
      }),
  })
  .strict()

const updateApiKeyBodySchema = z
  .object({
    keyId: z.string().min(1).meta({ description: "API key ID." }),
    configId: apiKeyConfigIdSchema.optional(),
    name: apiKeyNameSchema,
    connectionId: z.string().min(1).optional().meta({
      description:
        "Connection UUID. Required together with modelIds for AI grants.",
    }),
    modelIds: z.array(z.string().min(1)).max(200).optional().meta({
      description:
        "Replacement model grant for the ai profile. Omitted keeps the current grant; an empty array revokes every model. Rejected for the default profile.",
    }),
  })
  .strict()

const deleteApiKeyBodySchema = z
  .object({
    keyId: z.string().min(1).meta({ description: "API key ID." }),
    configId: apiKeyConfigIdSchema.optional(),
  })
  .strict()

const listApiKeysQuerySchema = z
  .object({ configId: apiKeyConfigIdSchema.optional() })
  .strict()

const getApiKeyQuerySchema = z
  .object({
    keyId: z.string().min(1).meta({ description: "API key ID." }),
    configId: apiKeyConfigIdSchema.optional(),
  })
  .strict()

const apiKeyFields = {
  id: z.string(),
  configId: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  enabled: z.boolean(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  referenceId: z.string(),
  lastRefillAt: z.string().nullable(),
  lastRequest: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  permissions: z.record(z.string(), z.array(z.string())).nullable(),
  rateLimitEnabled: z.boolean(),
  rateLimitMax: z.number().nullable(),
  rateLimitTimeWindow: z.number().nullable(),
  remaining: z.number().nullable(),
  refillAmount: z.number().nullable(),
  refillInterval: z.number().nullable(),
  requestCount: z.number(),
}
const apiKeySchema = z.object(apiKeyFields).openapi("ApiKey")
const createdApiKeySchema = z
  .object({ ...apiKeyFields, key: z.string() })
  .openapi("CreatedApiKey")
const apiKeyListSchema = z
  .object({
    apiKeys: z.array(apiKeySchema),
    total: z.number(),
    limit: z.number().nullable().optional(),
    offset: z.number().nullable().optional(),
  })
  .openapi("ApiKeyList")
const apiKeyDeletionSchema = z
  .object({ success: z.boolean() })
  .openapi("ApiKeyDeletion")

/**
 * 网关的失败响应有两种来源：应用自身的 Problem，以及插件服务端 API
 * 透传的原生错误（application/json）。按锁定版本的实际响应，原生错误
 * 始终包含 message，业务错误另带 code；500 由网关统一映射为 Problem 503，
 * 因此不假设所有原生错误都有相同字段。
 */
const apiKeyPluginErrorSchema = z
  .object({ message: z.string(), code: z.string().optional() })
  .openapi("ApiKeyPluginError")
const apiKeyManagementErrorResponse = {
  description:
    "Request rejected as an application Problem or returned by the plugin as a native error",
  content: {
    "application/problem+json": { schema: problemSchema },
    "application/json": { schema: apiKeyPluginErrorSchema },
  },
}

const ownerSessionSecurity = [{ ownerSession: [] }]

const createApiKeyRoute = createRoute({
  method: "post",
  path: "/api/auth/api-key/create",
  operationId: "createApiKey",
  security: ownerSessionSecurity,
  request: {
    body: {
      content: { "application/json": { schema: createApiKeyBodySchema } },
      required: true,
    },
  },
  responses: {
    default: apiKeyManagementErrorResponse,
    200: {
      description:
        "API key created inside one configuration profile; the raw key is returned only here",
      content: { "application/json": { schema: createdApiKeySchema } },
    },
  },
})

const listApiKeysRoute = createRoute({
  method: "get",
  path: "/api/auth/api-key/list",
  operationId: "listApiKeys",
  security: ownerSessionSecurity,
  request: { query: listApiKeysQuerySchema },
  responses: {
    default: apiKeyManagementErrorResponse,
    200: {
      description: "Owner API keys inside one configuration profile",
      content: { "application/json": { schema: apiKeyListSchema } },
    },
  },
})

const getApiKeyRoute = createRoute({
  method: "get",
  path: "/api/auth/api-key/get",
  operationId: "getApiKey",
  security: ownerSessionSecurity,
  request: { query: getApiKeyQuerySchema },
  responses: {
    default: apiKeyManagementErrorResponse,
    200: {
      description: "Owner API key inside one configuration profile",
      content: { "application/json": { schema: apiKeySchema } },
    },
  },
})

const updateApiKeyRoute = createRoute({
  method: "post",
  path: "/api/auth/api-key/update",
  operationId: "updateApiKey",
  security: ownerSessionSecurity,
  request: {
    body: {
      content: { "application/json": { schema: updateApiKeyBodySchema } },
      required: true,
    },
  },
  responses: {
    default: apiKeyManagementErrorResponse,
    200: {
      description:
        "API key renamed, and for the ai profile re-granted, inside one configuration profile",
      content: { "application/json": { schema: apiKeySchema } },
    },
  },
})

const deleteApiKeyRoute = createRoute({
  method: "post",
  path: "/api/auth/api-key/delete",
  operationId: "deleteApiKey",
  security: ownerSessionSecurity,
  request: {
    body: {
      content: { "application/json": { schema: deleteApiKeyBodySchema } },
      required: true,
    },
  },
  responses: {
    default: apiKeyManagementErrorResponse,
    200: {
      description:
        "API key revoked, or already absent from the requested profile",
      content: { "application/json": { schema: apiKeyDeletionSchema } },
    },
  },
})

/**
 * 只登记生成 OpenAPI 的契约；实际处理在 /api/auth/* 的统一入口里，
 * 由 handleApiKeyManagementRequest 复用同一组 schema。
 */
export function registerApiKeyManagementContract(
  app: OpenAPIHono<AppBindings>,
): void {
  app.openAPIRegistry.registerPath(createApiKeyRoute)
  app.openAPIRegistry.registerPath(listApiKeysRoute)
  app.openAPIRegistry.registerPath(getApiKeyRoute)
  app.openAPIRegistry.registerPath(updateApiKeyRoute)
  app.openAPIRegistry.registerPath(deleteApiKeyRoute)
}

function readQueryParameters(url: URL): Record<string, string> | undefined {
  const parameters: Record<string, string> = {}
  for (const key of url.searchParams.keys()) {
    if (url.searchParams.getAll(key).length > 1) return undefined
    parameters[key] = url.searchParams.get(key) ?? ""
  }
  return parameters
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string
  try {
    raw = await request.clone().text()
  } catch {
    return { ok: false }
  }
  // JSON.parse 会静默保留最后一个同名字段，必须在解析前拒绝重复的顶层参数。
  if (duplicateTopLevelJsonKeys(raw).length > 0) return { ok: false }
  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

async function callPluginApi(
  c: Context<AppBindings>,
  call: () => Promise<Response>,
): Promise<Response> {
  try {
    return await call()
  } catch {
    return problem("service-unavailable", c.get("requestId"))
  }
}

async function handleCreate(
  c: Context<AppBindings>,
  owner: OwnerSession,
): Promise<Response> {
  const requestId = c.get("requestId")
  const body = await readJsonBody(c.req.raw)
  if (!body.ok) return problem("invalid-request", requestId)
  const parsed = createApiKeyBodySchema.safeParse(body.body)
  if (!parsed.success)
    return problem(
      parsed.error.issues.every((issue) => issue.path[0] === "expiresIn")
        ? "api-key-expiration-required"
        : "validation-failed",
      requestId,
    )
  const aiProfile = parsed.data.purpose === API_KEY_AI_PURPOSE
  // The ai profile requires a model selection; the default profile rejects
  // the field instead of ignoring it.
  if (
    aiProfile &&
    (parsed.data.modelIds === undefined ||
      parsed.data.connectionId === undefined)
  )
    return problem("validation-failed", requestId)
  if (
    !aiProfile &&
    (parsed.data.modelIds !== undefined ||
      parsed.data.connectionId !== undefined)
  )
    return problem("validation-failed", requestId)

  let permissions: Record<string, string[]> | undefined
  let modelGrantCount = 0
  if (aiProfile) {
    const resolved = await resolveAiModelSelection(
      c.env.DB,
      parsed.data.connectionId!,
      parsed.data.modelIds ?? [],
    )
    if (!resolved.ok) return problem("validation-failed", requestId)
    permissions = buildAiKeyPermissions(resolved.selection)
    modelGrantCount = resolved.selection.modelIds.length
  }
  c.set("apiKeyAudit", {
    configId: aiProfile ? API_KEY_AI_CONFIG_ID : API_KEY_DEFAULT_CONFIG_ID,
    modelGrantCount,
  })
  return callPluginApi(c, () =>
    getRequestAuth(c).api.createApiKey({
      body: {
        configId: aiProfile ? API_KEY_AI_CONFIG_ID : API_KEY_DEFAULT_CONFIG_ID,
        name: parsed.data.name,
        ...(parsed.data.expiresIn === undefined
          ? {}
          : { expiresIn: parsed.data.expiresIn }),
        ...(permissions === undefined ? {} : { permissions }),
        userId: owner.subject,
      },
      asResponse: true,
    }),
  )
}

async function handleList(c: Context<AppBindings>): Promise<Response> {
  const requestId = c.get("requestId")
  const parameters = readQueryParameters(new URL(c.req.url))
  if (!parameters) return problem("invalid-request", requestId)
  const parsed = listApiKeysQuerySchema.safeParse(parameters)
  if (!parsed.success) return problem("validation-failed", requestId)
  return callPluginApi(c, () =>
    getRequestAuth(c).api.listApiKeys({
      headers: c.req.raw.headers,
      query: { configId: parsed.data.configId ?? API_KEY_DEFAULT_CONFIG_ID },
      asResponse: true,
    }),
  )
}

async function handleGet(c: Context<AppBindings>): Promise<Response> {
  const requestId = c.get("requestId")
  const parameters = readQueryParameters(new URL(c.req.url))
  if (!parameters) return problem("invalid-request", requestId)
  const parsed = getApiKeyQuerySchema.safeParse(parameters)
  if (!parsed.success) return problem("validation-failed", requestId)
  return callPluginApi(c, () =>
    getRequestAuth(c).api.getApiKey({
      headers: c.req.raw.headers,
      query: {
        id: parsed.data.keyId,
        configId: parsed.data.configId ?? API_KEY_DEFAULT_CONFIG_ID,
      },
      asResponse: true,
    }),
  )
}

async function handleUpdate(
  c: Context<AppBindings>,
  owner: OwnerSession,
): Promise<Response> {
  const requestId = c.get("requestId")
  const body = await readJsonBody(c.req.raw)
  if (!body.ok) return problem("invalid-request", requestId)
  const parsed = updateApiKeyBodySchema.safeParse(body.body)
  if (!parsed.success) return problem("validation-failed", requestId)
  const configId = parsed.data.configId ?? API_KEY_DEFAULT_CONFIG_ID
  // Model grants exist only in the ai profile; the default profile rejects
  // the field rather than silently dropping it.
  if (
    configId !== API_KEY_AI_CONFIG_ID &&
    (parsed.data.modelIds !== undefined ||
      parsed.data.connectionId !== undefined)
  )
    return problem("validation-failed", requestId)

  if (
    (parsed.data.connectionId === undefined) !==
    (parsed.data.modelIds === undefined)
  )
    return problem("validation-failed", requestId)

  let permissions: Record<string, string[]> | undefined
  let modelGrantCount = 0
  if (configId === API_KEY_AI_CONFIG_ID && parsed.data.modelIds !== undefined) {
    const resolved = await resolveAiModelSelection(
      c.env.DB,
      parsed.data.connectionId!,
      parsed.data.modelIds,
    )
    if (!resolved.ok) return problem("validation-failed", requestId)
    // An empty selection revokes every model grant while keeping the fixed
    // operations, so the key stays valid but can invoke nothing.
    permissions = buildAiKeyPermissions(resolved.selection)
    modelGrantCount = resolved.selection.modelIds.length
  }
  c.set("apiKeyAudit", { configId, modelGrantCount })
  return callPluginApi(c, () =>
    getRequestAuth(c).api.updateApiKey({
      body: {
        configId,
        keyId: parsed.data.keyId,
        name: parsed.data.name,
        ...(permissions === undefined ? {} : { permissions }),
        userId: owner.subject,
      },
      asResponse: true,
    }),
  )
}

/**
 * 归属预查通过后，插件查找前资源可能已被并发撤销，此时插件返回
 * KEY_NOT_FOUND。只有该 404 确实来自插件查找失败、且资源当前已不存在时
 * 才幂等完成；身份失败和其他 404 保留原生响应，确认查询的依赖异常返回
 * 503，都不转换成成功。
 */
async function confirmConcurrentRevocation(
  c: Context<AppBindings>,
  keyId: string,
  pluginResponse: Response,
): Promise<Response> {
  let code: unknown
  try {
    const body: unknown = await pluginResponse.clone().json()
    code =
      typeof body === "object" && body !== null && "code" in body
        ? (body as { code?: unknown }).code
        : undefined
  } catch {
    return pluginResponse
  }
  if (code !== "KEY_NOT_FOUND") return pluginResponse
  try {
    const stored = await c.env.DB.prepare(
      "SELECT 1 FROM apikey WHERE id=? LIMIT 1",
    )
      .bind(keyId)
      .first()
    if (stored) return pluginResponse
  } catch {
    return problem("service-unavailable", c.get("requestId"))
  }
  return Response.json({ success: true })
}

async function handleDelete(
  c: Context<AppBindings>,
  owner: OwnerSession,
): Promise<Response> {
  const requestId = c.get("requestId")
  const body = await readJsonBody(c.req.raw)
  if (!body.ok) return problem("invalid-request", requestId)
  const parsed = deleteApiKeyBodySchema.safeParse(body.body)
  if (!parsed.success) return problem("validation-failed", requestId)
  const configId = parsed.data.configId ?? API_KEY_DEFAULT_CONFIG_ID
  c.set("apiKeyAudit", { configId, modelGrantCount: 0 })

  let stored: { configId?: unknown; referenceId?: unknown } | null
  try {
    stored = await c.env.DB.prepare(
      "SELECT configId, referenceId FROM apikey WHERE id=? LIMIT 1",
    )
      .bind(parsed.data.keyId)
      .first()
  } catch {
    return problem("service-unavailable", requestId)
  }

  // 同档资源不存在时幂等完成；跨 owner 或跨档现存资源必须拒绝。
  if (!stored) return Response.json({ success: true })
  if (stored.referenceId !== owner.subject)
    return problem("permission-denied", requestId)
  const storedConfigId =
    stored.configId === undefined ||
    stored.configId === null ||
    stored.configId === ""
      ? API_KEY_DEFAULT_CONFIG_ID
      : stored.configId
  if (storedConfigId !== configId) return problem("not-found", requestId)

  const deleted = await callPluginApi(c, () =>
    getRequestAuth(c).api.deleteApiKey({
      headers: c.req.raw.headers,
      body: { configId, keyId: parsed.data.keyId },
      asResponse: true,
    }),
  )
  if (deleted.status !== 404) return deleted
  return confirmConcurrentRevocation(c, parsed.data.keyId, deleted)
}

/**
 * 五个管理 operation 保持与 Better Auth HTTP handler 等价的持久限流
 * （100 次 / 60 秒，按已登记 operation 与可信 IP 分桶）。计数依赖不可用时
 * 拒绝请求，不放行未计数的调用。
 */
async function applyPersistentRateLimit(
  c: Context<AppBindings>,
  operation: string,
): Promise<ReturnType<typeof problem> | undefined> {
  const requestId = c.get("requestId")
  let decision
  try {
    decision = await consumeAuthRateLimit(
      c.env.DB,
      authRateLimitBucketKey(
        operation,
        trustedRateLimitIp(c.req.raw, getRequestAuth(c).options),
      ),
    )
  } catch {
    return problem("service-unavailable", requestId)
  }
  if (decision.allowed) return undefined
  const response = problem("rate-limit-exceeded", requestId)
  response.headers.set("retry-after", String(decision.retryAfterSeconds))
  return response
}

export async function handleApiKeyManagementRequest(
  c: Context<AppBindings>,
): Promise<Response> {
  const requestId = c.get("requestId")
  const path = new URL(c.req.url).pathname
  const operation = `${c.req.method} ${path}`
  const kind = apiKeyManagementOperations.get(operation)
  if (!kind) return problem("not-found", requestId)
  const owner = c.get("principal")
  if (!owner) return problem("authentication-required", requestId)
  const limited = await applyPersistentRateLimit(c, operation)
  if (limited) return limited
  switch (kind) {
    case "create":
      return handleCreate(c, owner)
    case "list":
      return handleList(c)
    case "get":
      return handleGet(c)
    case "update":
      return handleUpdate(c, owner)
    case "delete":
      return handleDelete(c, owner)
  }
}
