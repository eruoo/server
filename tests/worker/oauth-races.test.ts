import { env } from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import { revokeClientFamilies } from "../../src/worker/oauth/families"
import {
  issueGrant,
  oauthFetch,
  refresh,
  storedTokenHash,
} from "./fixtures/oauth"
import { ownerSession } from "./fixtures/session"
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
  ])
})
it("does not branch a refresh family under two simultaneous rotations", async () => {
  const session = await ownerSession()
  const grant = await issueGrant(session.cookie)
  const results = await Promise.all([
    refresh(grant.refresh_token),
    refresh(grant.refresh_token),
  ])
  expect(results.map((value) => value.status).sort()).toEqual(
    expect.arrayContaining([200]),
  )
  expect(
    results.every((value) => value.status === 200 || value.status === 400),
  ).toBe(true)
  const bodies = await Promise.all(
    results
      .filter((value) => value.status === 200)
      .map((value) => value.json<{ refresh_token: string }>()),
  )
  expect(new Set(bodies.map((value) => value.refresh_token)).size).toBe(1)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM oauthRefreshToken WHERE revoked IS NULL",
    ).first("n"),
  ).toBe(1)
})
it("out-of-window reuse revokes only its own family and records detection once", async () => {
  const session = await ownerSession()
  const first = await issueGrant(session.cookie)
  const independent = await issueGrant(session.cookie)
  const rotated = await refresh(first.refresh_token)
  expect(rotated.status).toBe(200)
  await env.DB.prepare(
    "UPDATE oauthRefreshToken SET rotationReplayExpiresAt=?, rotationReplayResponse=NULL WHERE token=?",
  )
    .bind(
      new Date(Date.now() - 1000).toISOString(),
      storedTokenHash(first.refresh_token),
    )
    .run()
  expect((await refresh(first.refresh_token)).status).toBe(400)
  expect((await refresh(independent.refresh_token)).status).toBe(200)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM oauthRefreshTokenFamilyRevocation",
    ).first("n"),
  ).toBe(1)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM security_audit_events WHERE type='oauth_refresh_reuse_detected'",
    ).first("n"),
  ).toBe(1)
})
it.each(["", "Bearer ", "DPoP "])(
  "revokes an expired token's active successor with prefix %j",
  async (prefix) => {
    const session = await ownerSession()
    const grant = await issueGrant(session.cookie)
    const rotation = await refresh(grant.refresh_token)
    const successor = await rotation.json<{ refresh_token: string }>()
    await env.DB.prepare(
      "UPDATE oauthRefreshToken SET expiresAt=? WHERE token=?",
    )
      .bind(
        new Date(Date.now() - 1000).toISOString(),
        storedTokenHash(grant.refresh_token),
      )
      .run()
    const body = new URLSearchParams({
      client_id: "eruoo-desktop",
      token: prefix + grant.refresh_token,
      token_type_hint: "access_token",
    })
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await oauthFetch("/api/auth/oauth2/revoke", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          })
        ).status,
      ).toBe(200)
    expect((await refresh(successor.refresh_token)).status).toBe(400)
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM security_audit_events WHERE type='oauth_grant_revoked'",
      ).first("n"),
    ).toBe(1)
  },
)
it.each([
  { grantType: "refresh_token", tokenPrefix: null },
  { grantType: " refresh_token ", tokenPrefix: null },
  { grantType: "\trefresh_token\r\n", tokenPrefix: null },
  { grantType: "\u00a0refresh_token\u00a0", tokenPrefix: null },
  { grantType: "refresh_token", tokenPrefix: "" },
  { grantType: "refresh_token", tokenPrefix: "Bearer " },
  { grantType: "refresh_token", tokenPrefix: "DPoP " },
])(
  "preserves revocation during $grantType rotation (token prefix: $tokenPrefix)",
  async ({ grantType, tokenPrefix }) => {
    const session = await ownerSession()
    const grant = await issueGrant(session.cookie)
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let blocked = false
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values))
          const value = Reflect.get(target, property)
          if (typeof value !== "function") return value
          return async (...args: unknown[]) => {
            if (!blocked) {
              blocked = true
              entered()
              await pending
            }
            return Reflect.apply(value, target, args)
          }
        },
      })
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) =>
            /insert into ["`]?oauthRefreshToken["`]? /i.test(sql)
              ? wrap(target.prepare(sql))
              : target.prepare(sql)
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const inFlight = oauthFetch(
      "/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: grantType,
          client_id: "eruoo-desktop",
          refresh_token: grant.refresh_token,
        }),
      },
      database,
    )
    try {
      await Promise.race([
        started,
        inFlight,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Rotation did not reach INSERT")),
            2000,
          ),
        ),
      ])
      const revoked =
        tokenPrefix === null
          ? revokeClientFamilies(env.DB, session.id, "eruoo-desktop").then(
              () => 200,
            )
          : oauthFetch("/api/auth/oauth2/revoke", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: "eruoo-desktop",
                token: tokenPrefix + grant.refresh_token,
                token_type_hint: "refresh_token",
              }),
            }).then((response) => response.status)
      expect(await revoked).toBe(200)
    } finally {
      release()
    }
    expect((await inFlight).status).toBe(400)
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oauthRefreshToken WHERE revoked IS NULL",
      ).first("n"),
    ).toBe(0)
  },
)
