import type { BetterAuthPlugin } from "better-auth"
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2"
import { z } from "zod"

class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super("GitHub dependency unavailable")
  }
}

const tokenExchangeErrors = new Set([
  "incorrect_client_credentials",
  "bad_verification_code",
  "redirect_uri_mismatch",
])

async function readGitHubJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      "user-agent": "eruoo",
      ...init.headers,
    },
  })
  if (!response.ok) throw new GitHubHttpError(response.status)
  if (!response.body) throw new Error("GitHub returned an empty body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1_048_576) {
        void reader.cancel()
        throw new Error("GitHub response exceeded limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  )
}
const profileSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().nullable().optional(),
    login: z.string(),
    email: z.string().nullable().optional(),
    avatar_url: z.string().optional(),
  })
  .passthrough()
const emailSchema = z.array(
  z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
)
export function boundedGitHubTransport(): BetterAuthPlugin {
  return {
    id: "bounded-github-transport",
    init(context) {
      return {
        context: {
          socialProviders: context.socialProviders.map((provider) =>
            provider.id !== "github"
              ? provider
              : {
                  ...provider,
                  async validateAuthorizationCode(input) {
                    let reason = "request_failed"
                    try {
                      const request = await authorizationCodeRequest({
                        ...input,
                        options: provider.options ?? {},
                      })
                      const data = await readGitHubJson(
                        "https://github.com/login/oauth/access_token",
                        {
                          method: "POST",
                          body: request.body,
                          headers: request.headers,
                        },
                      )
                      if (
                        typeof data === "object" &&
                        data !== null &&
                        "error" in data
                      ) {
                        reason =
                          typeof data.error === "string" &&
                          tokenExchangeErrors.has(data.error)
                            ? data.error
                            : "oauth_error"
                        throw new Error("GitHub token request rejected")
                      }
                      reason = "invalid_token_response"
                      const parsed = z
                        .object({ access_token: z.string().min(1) })
                        .passthrough()
                        .parse(data)
                      return getOAuth2Tokens(parsed)
                    } catch (error) {
                      console.error({
                        event: "github_code_exchange_failed",
                        reason:
                          error instanceof GitHubHttpError
                            ? "http_error"
                            : reason,
                        ...(error instanceof GitHubHttpError
                          ? { status: error.status }
                          : {}),
                      })
                      throw error
                    }
                  },
                  async getUserInfo(token) {
                    const headers = {
                      authorization: `Bearer ${token.accessToken}`,
                    }
                    const profile = profileSchema.parse(
                      await readGitHubJson("https://api.github.com/user", {
                        headers,
                      }),
                    )
                    const emails = emailSchema.parse(
                      await readGitHubJson(
                        "https://api.github.com/user/emails",
                        { headers },
                      ),
                    )
                    const email =
                      profile.email ??
                      (emails.find((value) => value.primary) ?? emails[0])
                        ?.email
                    if (!email) return null
                    return {
                      user: {
                        name: profile.name || profile.login,
                        email,
                        image: profile.avatar_url,
                        emailVerified:
                          emails.find((value) => value.email === email)
                            ?.verified ?? false,
                      },
                      data: profile,
                    }
                  },
                },
          ),
        },
      }
    },
  }
}
