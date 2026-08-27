import createClient, { type Client } from "openapi-fetch"

import type { paths } from "../../../.generated/openapi"

export type EruooApiClient = Client<paths>
export type EruooApiFetch = (request: Request) => Promise<Response>

function sameOriginBaseUrl(): string {
  if (typeof globalThis.location === "object") {
    return globalThis.location.origin
  }

  return "http://localhost"
}

export function createEruooApiClient(fetcher?: EruooApiFetch): EruooApiClient {
  return createClient<paths>({
    baseUrl: sameOriginBaseUrl(),
    cache: "no-store",
    credentials: "include",
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
    headers: {
      Accept: "application/json, application/problem+json",
    },
  })
}

export const apiClient = createEruooApiClient()
