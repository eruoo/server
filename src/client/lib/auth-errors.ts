import { ApiResponseError } from "@client/lib/api-response"

interface CanonicalProblemIdentity {
  status: number
  type: string
}

function readCanonicalProblemIdentity(
  value: unknown,
  visited = new Set<object>(),
): CanonicalProblemIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (visited.has(value)) return undefined

  visited.add(value)

  const status = "status" in value ? value.status : undefined
  const type = "type" in value ? value.type : undefined

  if (
    typeof status === "number" &&
    Number.isSafeInteger(status) &&
    typeof type === "string" &&
    type.startsWith("https://auth.eruoo.me/problems/")
  ) {
    return { status, type }
  }

  if ("problem" in value) {
    const problem = readCanonicalProblemIdentity(value.problem, visited)
    if (problem && (status === undefined || status === problem.status)) {
      return problem
    }
  }

  if ("response" in value) {
    const problem = readCanonicalProblemIdentity(value.response, visited)
    if (problem && (status === undefined || status === problem.status)) {
      return problem
    }
  }
}

export function requiresRecentAuthentication(error: unknown): boolean {
  const problem = readCanonicalProblemIdentity(error)

  return (
    problem?.status === 403 &&
    problem.type ===
      "https://auth.eruoo.me/problems/recent-authentication-required"
  )
}

export function requiresAuthentication(error: unknown): boolean {
  if (!(error instanceof ApiResponseError)) return false

  const problem = readCanonicalProblemIdentity(error)

  return (
    problem?.status === 401 &&
    (problem.type ===
      "https://auth.eruoo.me/problems/authentication-required" ||
      problem.type === "https://auth.eruoo.me/problems/invalid-credential")
  )
}
