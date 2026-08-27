<script setup lang="ts">
import {
  inspectLoginContinuationLocation,
  isInvalidOAuthContinuationError,
} from "@client/features/auth/login-continuation"
import LoginPanel from "@client/features/auth/LoginPanel.vue"
import { authClient } from "@client/lib/auth-client"
import { onMounted, shallowRef } from "vue"
import { useRoute, useRouter } from "vue-router"

const router = useRouter()
const route = useRoute()
const authorizationRestartMessage =
  "授权请求无效或已过期，请返回调用应用重新发起授权。你仍可在此直接登录管理后台。"
const initialLoginLocation = inspectLoginContinuationLocation(route.fullPath)
const errorMessage = shallowRef<string | undefined>(
  initialLoginLocation.status === "invalid"
    ? authorizationRestartMessage
    : initialLoginLocation.hadUpstreamError
      ? "GitHub 登录未完成，请重试。"
      : undefined,
)
const pendingMethod = shallowRef<"github" | "passkey">()

onMounted(() => {
  if (route.fullPath === initialLoginLocation.normalizedLocation) return
  void router.replace(initialLoginLocation.normalizedLocation)
})

function isOAuthRedirect(
  value: unknown,
): value is { redirect: true; url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "redirect" in value &&
    value.redirect === true &&
    "url" in value &&
    typeof value.url === "string"
  )
}

async function discardInvalidAuthorizationContinuation() {
  errorMessage.value = authorizationRestartMessage

  if (route.fullPath !== "/login") {
    await router.replace("/login")
  }
}

async function prepareLoginAttempt() {
  const loginLocation = inspectLoginContinuationLocation(route.fullPath)
  if (loginLocation.status !== "invalid") return loginLocation

  await discardInvalidAuthorizationContinuation()
}

async function signInWithGitHub() {
  if (pendingMethod.value) return

  const loginLocation = await prepareLoginAttempt()
  if (!loginLocation) return

  errorMessage.value = undefined
  pendingMethod.value = "github"

  try {
    const result = await authClient.signIn.social({
      callbackURL: "/",
      errorCallbackURL: loginLocation.callbackLocation,
      provider: "github",
    })

    if (!result.error) {
      return
    }

    if (isInvalidOAuthContinuationError(result.error)) {
      await discardInvalidAuthorizationContinuation()
      return
    }

    errorMessage.value = "GitHub 登录未完成，请重试。"
  } catch (error) {
    if (isInvalidOAuthContinuationError(error)) {
      await discardInvalidAuthorizationContinuation()
      return
    }

    errorMessage.value = "GitHub 登录暂时不可用，请检查网络后重试。"
  } finally {
    pendingMethod.value = undefined
  }
}

async function signInWithPasskey() {
  if (pendingMethod.value) return

  const loginLocation = await prepareLoginAttempt()
  if (!loginLocation) return

  errorMessage.value = undefined
  pendingMethod.value = "passkey"

  try {
    const result = await authClient.signIn.passkey()

    if (result.error) {
      if (isInvalidOAuthContinuationError(result.error)) {
        await discardInvalidAuthorizationContinuation()
        return
      }

      errorMessage.value = "Passkey 验证未完成，请重试或使用 GitHub。"
      return
    }

    if (isOAuthRedirect(result.data)) return
    await router.replace("/")
  } catch (error) {
    if (isInvalidOAuthContinuationError(error)) {
      await discardInvalidAuthorizationContinuation()
      return
    }

    errorMessage.value = "Passkey 登录暂时不可用，请检查网络后重试。"
  } finally {
    pendingMethod.value = undefined
  }
}
</script>

<template>
  <main class="login-view">
    <div>
      <LoginPanel
        :disabled="Boolean(pendingMethod)"
        :pending-method="pendingMethod"
        @github="signInWithGitHub"
        @passkey="signInWithPasskey"
      />
      <p v-if="errorMessage" class="error-message" role="alert">
        {{ errorMessage }}
      </p>
    </div>
  </main>
</template>

<style scoped>
.login-view {
  display: grid;
  min-height: 100svh;
  padding: var(--spacing-6);
  place-items: center;
}

.error-message {
  max-width: 36rem;
  padding: var(--spacing-3) var(--spacing-4);
  margin-block-start: var(--spacing-4);
  border: var(--border-width-control) solid var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
  font-family: var(--font-mono);
}
</style>
