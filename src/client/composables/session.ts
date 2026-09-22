import { inject, readonly, shallowRef, type InjectionKey } from "vue"

import {
  inspectLoginContinuationLocation,
  isInvalidOAuthContinuationError,
} from "../features/auth/login-continuation"
import { authClient, type SessionData } from "../lib/auth-client"
import { redirectAuthenticationResult } from "../lib/auth-redirect"
import { requestJson } from "../lib/http"

type SessionStatus =
  | "authenticating"
  | "signing-out"
  | "checking"
  | "authenticated"
  | "anonymous"
  | "unavailable"
  | "refreshing"
export function createSessionController() {
  const status = shallowRef<SessionStatus>("checking")
  const data = shallowRef<SessionData | null>(null)
  const message = shallowRef("")
  let generation = 0
  let current: Promise<void> | undefined
  let lastChecked = 0
  let hiddenAt: number | undefined

  function captureCredentialFailureHandler() {
    const ownGeneration = generation
    const ownSessionId = data.value?.session.id
    return (error: unknown): boolean => {
      if (
        ownGeneration !== generation ||
        ownSessionId !== data.value?.session.id ||
        typeof error !== "object" ||
        error === null ||
        !("status" in error) ||
        error.status !== 401 ||
        !("type" in error) ||
        ![
          "https://auth.eruoo.me/problems/authentication-required",
          "https://auth.eruoo.me/problems/invalid-credential",
        ].includes(error.type as string)
      )
        return false
      invalidate()
      data.value = null
      status.value = "anonymous"
      message.value = ""
      return true
    }
  }

  function refresh(force = false, background = false): Promise<void> {
    if (status.value === "authenticating" || status.value === "signing-out")
      return Promise.resolve()
    if (current) return current
    if (!force && lastChecked && Date.now() - lastChecked < 30_000)
      return Promise.resolve()
    const ownGeneration = generation
    const handleCredentialFailure = captureCredentialFailureHandler()
    if (!background || !data.value)
      status.value = data.value ? "refreshing" : "checking"
    current = (async () => {
      try {
        const result = await requestJson<SessionData | null>(
          "/api/auth/get-session",
        )
        if (ownGeneration !== generation) return
        data.value = result
        status.value = result ? "authenticated" : "anonymous"
        message.value = ""
        lastChecked = Date.now()
      } catch (error) {
        if (ownGeneration !== generation) return
        if (handleCredentialFailure(error)) return
        status.value =
          background && data.value ? "authenticated" : "unavailable"
        message.value = "暂时无法确认登录状态，请重试。"
      } finally {
        if (ownGeneration === generation) current = undefined
      }
    })()
    return current
  }

  /** Brief window/Space switches keep the current UI; long absences recheck quietly. */
  function visibilityChanged(visible: boolean): Promise<void> {
    if (!visible) {
      hiddenAt ??= Date.now()
      return Promise.resolve()
    }
    const leftAt = hiddenAt
    hiddenAt = undefined
    if (leftAt === undefined || Date.now() - leftAt < 5 * 60_000)
      return Promise.resolve()
    return refresh(false, true)
  }

  function invalidate() {
    generation++
    current = undefined
    lastChecked = 0
  }
  function cancelAuthentication() {
    if (status.value !== "authenticating") return
    invalidate()
    status.value = data.value ? "authenticated" : "anonymous"
    message.value = ""
  }
  async function signOut() {
    if (status.value === "signing-out") return
    invalidate()
    const ownGeneration = generation
    status.value = "signing-out"
    try {
      const result = await authClient.signOut()
      if (ownGeneration !== generation) return
      if (result.error) throw new Error("sign out failed")
      data.value = null
      status.value = "anonymous"
      message.value = ""
    } catch {
      if (ownGeneration !== generation) return
      status.value = "unavailable"
      message.value = "未确认退出，请重试退出。"
    }
  }
  function prepareAuthentication() {
    if (["authenticating", "signing-out"].includes(status.value)) return false
    const continuation = inspectLoginContinuationLocation(
      window.location.pathname + window.location.search,
    )
    if (continuation.status === "invalid") {
      window.location.replace("/login?error=invalid_signature")
      message.value =
        "授权已过期，请返回调用应用重新发起。你仍可直接登录管理后台。"
      return false
    }
    invalidate()
    status.value = "authenticating"
    message.value = ""
    return continuation
  }
  function authenticationFailed(error: unknown) {
    status.value = data.value ? "authenticated" : "anonymous"
    if (isInvalidOAuthContinuationError(error)) {
      window.location.replace("/login?error=invalid_signature")
      message.value =
        "授权已失效，请返回调用应用重新发起。你仍可直接登录管理后台。"
    } else message.value = "身份验证未完成，请重试或使用其他登录方式。"
  }
  async function signIn() {
    const continuation = prepareAuthentication()
    if (!continuation) return
    const ownGeneration = generation
    try {
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL:
          window.location.pathname === "/login"
            ? "/"
            : window.location.pathname,
        errorCallbackURL:
          continuation.status === "current"
            ? continuation.callbackLocation
            : "/login",
      })
      if (ownGeneration !== generation) return
      if (result.error) authenticationFailed(result.error)
      else redirectAuthenticationResult(result.data)
    } catch (error) {
      if (ownGeneration === generation) authenticationFailed(error)
    }
  }
  async function signInPasskey() {
    if (!prepareAuthentication()) return
    const ownGeneration = generation
    try {
      const result = await authClient.signIn.passkey()
      if (ownGeneration !== generation) return
      if (result.error) {
        authenticationFailed(result.error)
        return
      }
      if (redirectAuthenticationResult(result.data)) return
      status.value = data.value ? "authenticated" : "anonymous"
      await refresh(true)
    } catch (error) {
      if (ownGeneration === generation) authenticationFailed(error)
    }
  }
  return {
    status: readonly(status),
    data: readonly(data),
    message: readonly(message),
    refresh,
    visibilityChanged,
    signIn,
    signInPasskey,
    signOut,
    cancelAuthentication,
    captureCredentialFailureHandler,
    invalidate,
  }
}
export type SessionController = ReturnType<typeof createSessionController>
export const sessionKey: InjectionKey<SessionController> = Symbol("session")
export function useSession() {
  const session = inject(sessionKey)
  if (!session) throw new Error("Session controller is not provided")
  return session
}
