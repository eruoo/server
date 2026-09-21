import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { issueGrant, oauthFetch, origin } from "./fixtures/oauth"
import { ownerSession } from "./fixtures/session"

const path = "/api/oauth/authorizations"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauthAccessToken"),
    env.DB.prepare("DELETE FROM oauthRefreshToken"),
    env.DB.prepare("DELETE FROM oauthConsent"),
    env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM user"),
  ])
})

async function listAuthorizations(cookie: string) {
  return oauthFetch(path, { headers: { cookie } })
}

async function revokeAuthorization(cookie: string, clientId: string) {
  return oauthFetch(`${path}/${clientId}`, {
    method: "DELETE",
    headers: { cookie, origin },
  })
}

describe("oauth authorization listing", () => {
  it("rejects anonymous access and mixed credential carriers", async () => {
    expect((await listAuthorizations("")).status).toBe(401)
    const session = await ownerSession()
    const mixed = await oauthFetch(path, {
      headers: { cookie: session.cookie, authorization: "Bearer abc" },
    })
    expect(mixed.status).toBe(400)
  })

  it("lists per-client authorization state only for the owner session", async () => {
    const session = await ownerSession()
    const grant = await issueGrant(session.cookie)
    expect(grant.refresh_token).toBeTruthy()
    const response = await listAuthorizations(session.cookie)
    expect(response.status).toBe(200)
    const list = await response.json<
      Array<{
        activeRefreshTokenCount: number
        authorized: boolean
        clientId: string
        consentCount: number
        offlineAccess: boolean
      }>
    >()
    const desktop = list.find((entry) => entry.clientId === "eruoo-desktop")
    expect(desktop).toMatchObject({
      activeRefreshTokenCount: 1,
      authorized: true,
      consentCount: 0,
      offlineAccess: true,
    })
    const others = list.filter((entry) => entry.clientId !== "eruoo-desktop")
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((entry) => entry.authorized === false)).toBe(true)
  })
})

describe("oauth authorization revocation", () => {
  it("rejects anonymous access, wrong origins, and unknown clients", async () => {
    expect((await revokeAuthorization("", "eruoo-desktop")).status).toBe(401)
    const session = await ownerSession()
    const crossOrigin = await oauthFetch(`${path}/eruoo-desktop`, {
      method: "DELETE",
      headers: { cookie: session.cookie, origin: "https://evil.example" },
    })
    expect(crossOrigin.status).toBe(403)
    expect(
      (await revokeAuthorization(session.cookie, "unknown-client")).status,
    ).toBe(404)
  })

  it("requires a recent owner session to revoke", async () => {
    const session = await ownerSession()
    await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
      .bind(new Date(Date.now() - 40 * 60 * 1000).toISOString(), session.id)
      .run()
    const response = await revokeAuthorization(session.cookie, "eruoo-desktop")
    expect(response.status).toBe(403)
    const body = await response.json<{ type?: string }>()
    expect(body.type).toContain("recent-authentication-required")
  })

  it("revokes the client's offline authorization, records the audit event, and is idempotent by absence", async () => {
    const session = await ownerSession()
    await issueGrant(session.cookie)
    const revoked = await revokeAuthorization(session.cookie, "eruoo-desktop")
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({
      clientId: "eruoo-desktop",
      deletedConsentCount: 0,
      revokedRefreshTokenCount: 1,
    })
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oauthRefreshToken WHERE userId=? AND revoked IS NULL",
      )
        .bind(session.id)
        .first("n"),
    ).toBe(0)
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM oauthRefreshTokenFamilyRevocation WHERE userId=?",
      )
        .bind(session.id)
        .first("n"),
    ).toBe(1)
    const audits = await env.DB.prepare(
      "SELECT type,outcome,clientId FROM security_audit_events WHERE type='oauth_grant_revoked'",
    ).all<{ type: string; outcome: string; clientId: string }>()
    expect(audits.results).toEqual([
      {
        clientId: "eruoo-desktop",
        outcome: "success",
        type: "oauth_grant_revoked",
      },
    ])
    const repeated = await revokeAuthorization(session.cookie, "eruoo-desktop")
    expect(repeated.status).toBe(404)
  })
})
