<script setup lang="ts">
import { authClient } from "@client/lib/auth-client"
import { computed, watch } from "vue"
import { RouterView, useRoute, useRouter } from "vue-router"

type AuthenticationState = "authenticated" | "unauthenticated" | "unknown"

const route = useRoute()
const router = useRouter()
const session = authClient.useSession()
const authenticationState = computed<AuthenticationState>(() => {
  if (session.value.error) return "unknown"
  if (session.value.isPending || session.value.isRefetching) return "unknown"
  if (session.value.data) return "authenticated"

  return "unauthenticated"
})
let previousAuthenticationState: AuthenticationState | undefined

watch(
  [authenticationState, () => route.name],
  ([currentAuthenticationState, routeName]) => {
    const authenticationStateChanged =
      currentAuthenticationState !== previousAuthenticationState
    previousAuthenticationState = currentAuthenticationState

    if (
      currentAuthenticationState === "unauthenticated" &&
      routeName !== "login"
    ) {
      void router.replace({ name: "login" })
      return
    }

    if (
      currentAuthenticationState === "authenticated" &&
      routeName === "login" &&
      authenticationStateChanged
    ) {
      void router.replace({ name: "home" })
    }
  },
  { immediate: true },
)
</script>

<template>
  <RouterView />
</template>
