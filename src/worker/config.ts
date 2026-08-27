import { z } from "zod"

import { OWNER_GITHUB_ID } from "../shared/security"

const productionOrigin = "https://auth.eruoo.me"
const appEnvironmentSchema = z.enum(["development", "production"])

const secretEntrySchema = z.object({
  value: z.string().min(32),
  version: z.number().int().nonnegative(),
})

const corsOriginsSchema = z.array(z.url()).superRefine((origins, context) => {
  for (const origin of origins) {
    if (origin.includes("*")) {
      context.addIssue({
        code: "custom",
        message: "CORS origins must not contain wildcards",
      })
    }

    if (new URL(origin).origin !== origin) {
      context.addIssue({
        code: "custom",
        message: "CORS entries must be exact origins",
      })
    }
  }
})

function isDevelopmentLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  )
}

function parseCorsOrigins(
  rawOrigins: string,
  appEnv: RuntimeConfig["appEnv"],
): string[] {
  let origins: string[]

  try {
    origins = corsOriginsSchema.parse(JSON.parse(rawOrigins))
  } catch {
    throw new RuntimeConfigError(
      "ALLOWED_CORS_ORIGINS must be a JSON array of exact origins",
    )
  }

  for (const origin of origins) {
    const url = new URL(origin)
    const allowsDevelopmentHttp =
      appEnv === "development" &&
      url.protocol === "http:" &&
      isDevelopmentLoopback(url.hostname)

    if (url.protocol !== "https:" && !allowsDevelopmentHttp) {
      throw new RuntimeConfigError(
        "CORS origins must use HTTPS except for loopback development",
      )
    }
  }

  return origins
}

export interface RuntimeConfig {
  allowedCorsOrigins: ReadonlySet<string>
  appOrigin: string
  appOriginUrl: URL
  appEnv: "development" | "production"
  betterAuthSecrets: Array<z.infer<typeof secretEntrySchema>>
  githubClientId: string
  githubClientSecret: string
  ownerGitHubId: string
  passkeyRpId: string
}

type AuthEnvKey =
  | "ALLOWED_CORS_ORIGINS"
  | "APP_ENV"
  | "APP_ORIGIN"
  | "BETTER_AUTH_SECRETS"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "OWNER_GITHUB_ID"

type WidenString<T> = T extends string ? string : T

export type AuthEnv = {
  [Key in AuthEnvKey]: Key extends "APP_ENV" ? Env[Key] : WidenString<Env[Key]>
}

export class RuntimeConfigError extends Error {
  override readonly name = "RuntimeConfigError"
}

const runtimeConfigByEnvironment = new WeakMap<object, RuntimeConfig>()

function parseOrigin(rawOrigin: string, appEnv: RuntimeConfig["appEnv"]): URL {
  let origin: URL

  try {
    origin = new URL(rawOrigin)
  } catch {
    throw new RuntimeConfigError("APP_ORIGIN must be a valid URL origin")
  }

  if (origin.origin !== rawOrigin || origin.pathname !== "/") {
    throw new RuntimeConfigError("APP_ORIGIN must not include a path or slash")
  }

  if (appEnv === "production" && origin.origin !== productionOrigin) {
    throw new RuntimeConfigError(
      `Production APP_ORIGIN must be ${productionOrigin}`,
    )
  }

  if (
    origin.protocol !== "https:" &&
    !(appEnv === "development" && origin.hostname === "localhost") &&
    !(appEnv === "development" && origin.hostname === "127.0.0.1")
  ) {
    throw new RuntimeConfigError(
      "APP_ORIGIN must use HTTPS except for local development",
    )
  }

  return origin
}

export function parseVersionedSecrets(
  rawSecrets: string,
): RuntimeConfig["betterAuthSecrets"] {
  const entries = rawSecrets.split(",").map((rawEntry) => {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(":")

    if (separator < 1) {
      throw new RuntimeConfigError(
        "BETTER_AUTH_SECRETS entries must use <version>:<secret>",
      )
    }

    return secretEntrySchema.parse({
      value: entry.slice(separator + 1).trim(),
      version: Number(entry.slice(0, separator)),
    })
  })

  if (entries.length === 0) {
    throw new RuntimeConfigError("BETTER_AUTH_SECRETS must not be empty")
  }

  const versions = new Set(entries.map(({ version }) => version))
  if (versions.size !== entries.length) {
    throw new RuntimeConfigError("BETTER_AUTH_SECRETS versions must be unique")
  }

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]

    if (!previous || !current || previous.version <= current.version) {
      throw new RuntimeConfigError(
        "BETTER_AUTH_SECRETS must list the newest version first",
      )
    }
  }

  return entries
}

export function getRuntimeConfig(env: AuthEnv): RuntimeConfig {
  const cached = runtimeConfigByEnvironment.get(env)
  if (cached) {
    return cached
  }

  const appEnvironment = appEnvironmentSchema.safeParse(env.APP_ENV)
  if (!appEnvironment.success) {
    throw new RuntimeConfigError(
      "APP_ENV must be either development or production",
    )
  }

  const appOriginUrl = parseOrigin(env.APP_ORIGIN, appEnvironment.data)
  const allowedCorsOrigins = parseCorsOrigins(
    env.ALLOWED_CORS_ORIGINS,
    appEnvironment.data,
  )

  if (env.OWNER_GITHUB_ID !== OWNER_GITHUB_ID) {
    throw new RuntimeConfigError(
      `OWNER_GITHUB_ID must be the approved owner ${OWNER_GITHUB_ID}`,
    )
  }

  const config: RuntimeConfig = {
    allowedCorsOrigins: new Set(allowedCorsOrigins),
    appEnv: appEnvironment.data,
    appOrigin: appOriginUrl.origin,
    appOriginUrl,
    betterAuthSecrets: parseVersionedSecrets(env.BETTER_AUTH_SECRETS),
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    ownerGitHubId: env.OWNER_GITHUB_ID,
    passkeyRpId: appOriginUrl.hostname,
  }

  runtimeConfigByEnvironment.set(env, config)
  return config
}
