const httpMethods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const

type HttpMethod = (typeof httpMethods)[number]

export type OpenApiOperationKey = `${Uppercase<HttpMethod>} /${string}`

export interface OpenApiRuntimeRequestFixture {
  body?: string
  headers?: Readonly<Record<string, string>>
  path: `/${string}`
}

export type OpenApiRuntimeRequestFixtures = Readonly<
  Partial<Record<OpenApiOperationKey, OpenApiRuntimeRequestFixture>>
>

interface OpenApiOperation {
  declaredResponseStatuses: ReadonlySet<string>
  hasRequestBody: boolean
  key: OpenApiOperationKey
  method: HttpMethod
  operationId: string
  path: string
  protected: boolean
}

interface RuntimeRequest {
  body?: string
  headers?: Readonly<Record<string, string>>
  method: Uppercase<HttpMethod>
  path: string
}

interface AssertOpenApiContractOptions {
  document: unknown
  publicOperationAllowlist: readonly OpenApiOperationKey[]
}

interface AssertProtectedOperationsRejectAnonymousOptions extends AssertOpenApiContractOptions {
  invoke: (request: RuntimeRequest) => Promise<Response>
  requestFixtures: OpenApiRuntimeRequestFixtures
}

const maximumPublicOperationCount = 8
const prohibitedCredentialHeaders = new Set([
  "authorization",
  "cookie",
  "x-api-key",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function operationKey(method: HttpMethod, path: string): OpenApiOperationKey {
  return `${method.toUpperCase() as Uppercase<HttpMethod>} ${path}` as OpenApiOperationKey
}

function validateSecurityRequirements(
  key: OpenApiOperationKey,
  security: unknown[],
  errors: string[],
): boolean {
  if (security.length === 0) {
    return false
  }

  for (const requirement of security) {
    if (!isRecord(requirement) || Object.keys(requirement).length === 0) {
      errors.push(
        `${key} must use security: [] for public access; empty security requirement alternatives are not allowed`,
      )
      continue
    }

    for (const [scheme, scopes] of Object.entries(requirement)) {
      if (
        !Array.isArray(scopes) ||
        !scopes.every((scope) => typeof scope === "string")
      ) {
        errors.push(
          `${key} security requirement ${scheme} must contain a string scope array`,
        )
      }
    }
  }

  return true
}

function validateResponses(
  key: OpenApiOperationKey,
  operation: Record<string, unknown>,
  protectedOperation: boolean,
  errors: string[],
): ReadonlySet<string> {
  if (!isRecord(operation["responses"])) {
    errors.push(`${key} must declare a responses object`)
    return new Set()
  }

  const responseEntries = Object.entries(operation["responses"])
  const concreteStatuses = responseEntries
    .map(([status]) => status)
    .filter((status) => /^[1-5]\d{2}$/.test(status))

  if (!concreteStatuses.some((status) => status.startsWith("2"))) {
    errors.push(`${key} must declare at least one concrete 2xx response`)
  }

  if (protectedOperation && !concreteStatuses.includes("401")) {
    errors.push(`${key} is protected and must declare a 401 response`)
  }

  for (const [status, response] of responseEntries) {
    if (status !== "default" && !/^[1-5]\d{2}$/.test(status)) {
      errors.push(
        `${key} response ${status} must be a concrete HTTP status or default`,
      )
    }

    if (
      !isRecord(response) ||
      typeof response["description"] !== "string" ||
      response["description"].trim().length === 0
    ) {
      errors.push(`${key} response ${status} must have a description`)
    }
  }

  return new Set(concreteStatuses)
}

function collectOperations(
  document: unknown,
  errors: string[],
): OpenApiOperation[] {
  if (!isRecord(document) || !isRecord(document["paths"])) {
    errors.push("The OpenAPI document must contain a paths object")
    return []
  }

  const operations: OpenApiOperation[] = []

  for (const [path, pathItem] of Object.entries(document["paths"])) {
    if (!isRecord(pathItem)) {
      errors.push(`OpenAPI path ${path} must contain a Path Item Object`)
      continue
    }

    for (const method of httpMethods) {
      const operation = pathItem[method]
      if (operation === undefined) {
        continue
      }

      const key = operationKey(method, path)
      if (!isRecord(operation)) {
        errors.push(`${key} must contain an Operation Object`)
        continue
      }

      const operationId = operation["operationId"]
      if (typeof operationId !== "string" || operationId.trim().length === 0) {
        errors.push(`${key} must declare a non-empty operationId`)
        continue
      }

      let protectedOperation = false
      if (!Object.hasOwn(operation, "security")) {
        errors.push(
          `${key} must declare operation-level security explicitly; document-level defaults are not accepted`,
        )
      } else if (!Array.isArray(operation["security"])) {
        errors.push(`${key} security must be an array`)
      } else {
        protectedOperation = validateSecurityRequirements(
          key,
          operation["security"],
          errors,
        )
      }

      operations.push({
        declaredResponseStatuses: validateResponses(
          key,
          operation,
          protectedOperation,
          errors,
        ),
        hasRequestBody: Object.hasOwn(operation, "requestBody"),
        key,
        method,
        operationId,
        path,
        protected: protectedOperation,
      })
    }
  }

  if (operations.length === 0) {
    errors.push("The OpenAPI document must contain at least one operation")
  }

  return operations
}

function validateUniqueOperationIds(
  operations: readonly OpenApiOperation[],
  errors: string[],
): void {
  const operationById = new Map<string, OpenApiOperation>()

  for (const operation of operations) {
    const existing = operationById.get(operation.operationId)
    if (existing) {
      errors.push(
        `operationId ${operation.operationId} is used by both ${existing.key} and ${operation.key}`,
      )
    } else {
      operationById.set(operation.operationId, operation)
    }
  }
}

function validatePublicOperationAllowlist(
  operations: readonly OpenApiOperation[],
  allowlist: readonly OpenApiOperationKey[],
  errors: string[],
): void {
  if (allowlist.length > maximumPublicOperationCount) {
    errors.push(
      `Public operation allowlist exceeds the ${maximumPublicOperationCount}-operation safety limit`,
    )
  }

  const allowlistedOperations = new Set<OpenApiOperationKey>()
  for (const key of allowlist) {
    if (allowlistedOperations.has(key)) {
      errors.push(`Public operation allowlist contains duplicate ${key}`)
    }
    allowlistedOperations.add(key)
  }

  const publicOperations = new Set(
    operations
      .filter((operation) => !operation.protected)
      .map((operation) => operation.key),
  )

  for (const key of publicOperations) {
    if (!allowlistedOperations.has(key)) {
      errors.push(`${key} is public but is missing from the explicit allowlist`)
    }
  }

  for (const key of allowlistedOperations) {
    if (!publicOperations.has(key)) {
      errors.push(`${key} is allowlisted as public but is absent or protected`)
    }
  }
}

function throwContractErrors(errors: readonly string[]): never {
  throw new Error(
    `OpenAPI contract invariant violations:\n${errors.map((error) => `- ${error}`).join("\n")}`,
  )
}

function inspectOpenApiContract({
  document,
  publicOperationAllowlist,
}: AssertOpenApiContractOptions): OpenApiOperation[] {
  const errors: string[] = []
  const operations = collectOperations(document, errors)

  validateUniqueOperationIds(operations, errors)
  validatePublicOperationAllowlist(operations, publicOperationAllowlist, errors)

  if (errors.length > 0) {
    throwContractErrors(errors)
  }

  return operations
}

export function assertOpenApiContract(
  options: AssertOpenApiContractOptions,
): void {
  inspectOpenApiContract(options)
}

function pathMatchesTemplate(path: string, template: string): boolean {
  const actualSegments = path.split("/")
  const templateSegments = template.split("/")

  return (
    actualSegments.length === templateSegments.length &&
    templateSegments.every((segment, index) => {
      const actualSegment = actualSegments[index]
      return /^\{[^{}]+\}$/.test(segment)
        ? actualSegment !== undefined && actualSegment.length > 0
        : segment === actualSegment
    })
  )
}

function validateRuntimeFixture(
  operation: OpenApiOperation,
  fixture: OpenApiRuntimeRequestFixture,
): void {
  const fixtureUrl = new URL(fixture.path, "https://openapi.invalid")
  if (!pathMatchesTemplate(fixtureUrl.pathname, operation.path)) {
    throw new Error(
      `Runtime request fixture for ${operation.key} targets ${fixtureUrl.pathname}, which does not match its path template`,
    )
  }

  for (const header of Object.keys(fixture.headers ?? {})) {
    if (prohibitedCredentialHeaders.has(header.toLowerCase())) {
      throw new Error(
        `Runtime request fixture for ${operation.key} must not contain credential header ${header}`,
      )
    }
  }
}

function runtimeRequestForOperation(
  operation: OpenApiOperation,
  fixtures: OpenApiRuntimeRequestFixtures,
): RuntimeRequest {
  const fixture = fixtures[operation.key]

  if (fixture) {
    validateRuntimeFixture(operation, fixture)
    return {
      ...(fixture.body === undefined ? {} : { body: fixture.body }),
      ...(fixture.headers === undefined ? {} : { headers: fixture.headers }),
      method: operation.method.toUpperCase() as Uppercase<HttpMethod>,
      path: fixture.path,
    }
  }

  if (
    operation.method !== "get" ||
    operation.hasRequestBody ||
    operation.path.includes("{")
  ) {
    throw new Error(
      `Protected operation ${operation.key} needs an explicit anonymous runtime request fixture`,
    )
  }

  return {
    method: "GET",
    path: operation.path,
  }
}

export async function assertProtectedOperationsRejectAnonymous({
  document,
  invoke,
  publicOperationAllowlist,
  requestFixtures,
}: AssertProtectedOperationsRejectAnonymousOptions): Promise<void> {
  const operations = inspectOpenApiContract({
    document,
    publicOperationAllowlist,
  })
  const protectedOperations = operations.filter(
    (operation) => operation.protected,
  )
  const protectedOperationKeys = new Set(
    protectedOperations.map((operation) => operation.key),
  )

  for (const key of Object.keys(requestFixtures) as OpenApiOperationKey[]) {
    if (!protectedOperationKeys.has(key)) {
      throw new Error(
        `Anonymous runtime request fixture ${key} is stale or does not target a protected operation`,
      )
    }
  }

  for (const operation of protectedOperations) {
    const response = await invoke(
      runtimeRequestForOperation(operation, requestFixtures),
    )

    if (response.status !== 401) {
      throw new Error(
        `Protected operation ${operation.key} returned ${response.status} to an anonymous request; expected 401`,
      )
    }

    if (!operation.declaredResponseStatuses.has(String(response.status))) {
      throw new Error(
        `Protected operation ${operation.key} returned undocumented status ${response.status}`,
      )
    }
  }
}
