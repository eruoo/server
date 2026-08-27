import type { components } from "../../../.generated/openapi"

const problemTypePattern =
  /^https:\/\/auth\.eruoo\.me\/problems\/[a-z0-9]+(?:-[a-z0-9]+)*$/

const problemRequiredKeys = [
  "detail",
  "requestId",
  "status",
  "title",
  "type",
] as const

const validationIssueKeys = ["detail", "location", "pointer"] as const

type ProblemContract = components["schemas"]["Problem"]
type ValidationIssueContract = components["schemas"]["ValidationIssue"]

export interface ApiProblem extends Omit<ProblemContract, "errors"> {
  errors?: readonly ValidationIssueContract[]
}

interface OpenApiFetchResult {
  data?: unknown
  error?: unknown
  response: Response
}

export class ApiResponseError extends Error {
  readonly problem: ApiProblem | undefined
  readonly status: number | undefined

  constructor(message: string, problem?: ApiProblem) {
    super(message)
    this.name = "ApiResponseError"
    this.problem = problem
    this.status = problem?.status
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()

  return (
    actualKeys.length === sortedExpectedKeys.length &&
    sortedExpectedKeys.every(
      (expectedKey, index) => actualKeys[index] === expectedKey,
    )
  )
}

export function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function responseMediaType(response: Response): string {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  )
}

function parseValidationIssue(value: unknown): ValidationIssueContract {
  if (!isRecord(value) || !hasExactKeys(value, validationIssueKeys)) {
    throw new ApiResponseError("API Problem validation issue is invalid.")
  }

  const detail = value["detail"]
  const location = value["location"]
  const pointer = value["pointer"]

  if (
    typeof detail !== "string" ||
    !(
      location === "body" ||
      location === "header" ||
      location === "path" ||
      location === "query"
    ) ||
    typeof pointer !== "string"
  ) {
    throw new ApiResponseError("API Problem validation issue is invalid.")
  }

  return { detail, location, pointer }
}

function parseProblem(value: unknown, responseStatus: number): ApiProblem {
  if (!isRecord(value)) {
    throw new ApiResponseError("API Problem is invalid.")
  }

  const expectedKeys =
    value["errors"] === undefined
      ? problemRequiredKeys
      : [...problemRequiredKeys, "errors"]
  const detail = value["detail"]
  const requestId = value["requestId"]
  const status = value["status"]
  const title = value["title"]
  const type = value["type"]

  if (
    !hasExactKeys(value, expectedKeys) ||
    typeof detail !== "string" ||
    typeof requestId !== "string" ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status !== responseStatus ||
    typeof title !== "string" ||
    typeof type !== "string" ||
    !problemTypePattern.test(type)
  ) {
    throw new ApiResponseError("API Problem is invalid.")
  }

  let errors: readonly ValidationIssueContract[] | undefined
  if (value["errors"] !== undefined) {
    if (!Array.isArray(value["errors"])) {
      throw new ApiResponseError("API Problem errors are invalid.")
    }
    errors = value["errors"].map(parseValidationIssue)
  }

  return {
    detail,
    ...(errors === undefined ? {} : { errors: [...errors] }),
    requestId,
    status,
    title,
    type,
  }
}

function wrapRequestFailure(error: unknown): ApiResponseError {
  if (error instanceof ApiResponseError) return error

  return new ApiResponseError(
    error instanceof SyntaxError
      ? "API response is not valid JSON."
      : "API request failed.",
  )
}

export async function readApiJson<T>(
  request: () => Promise<OpenApiFetchResult>,
  parse: (value: unknown) => T,
  expectedStatus = 200,
): Promise<T> {
  let result: OpenApiFetchResult

  try {
    result = await request()
  } catch (error) {
    throw wrapRequestFailure(error)
  }

  const { response } = result

  if (!response.ok) {
    if (responseMediaType(response) !== "application/problem+json") {
      throw new ApiResponseError("API error response is invalid.")
    }

    const problem = parseProblem(result.error, response.status)
    throw new ApiResponseError(problem.detail, problem)
  }

  if (
    response.status !== expectedStatus ||
    responseMediaType(response) !== "application/json"
  ) {
    throw new ApiResponseError("API success response is invalid.")
  }

  try {
    return parse(result.data)
  } catch (error) {
    throw wrapRequestFailure(error)
  }
}
