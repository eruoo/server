import { authClient } from "@client/lib/auth-client"
import AuditLogView from "@client/views/AuditLogView.vue"
import AuthorizedAppsView from "@client/views/AuthorizedAppsView.vue"
import HomeView from "@client/views/HomeView.vue"
import LoginView from "@client/views/LoginView.vue"
import NotFoundView from "@client/views/NotFoundView.vue"
import { nextTick } from "vue"
import { createRouter, createWebHistory } from "vue-router"

interface SessionReaderResult {
  data?: { session?: unknown } | null
  error?: unknown
}

interface CreateAppRouterOptions {
  getSession?: () => Promise<SessionReaderResult>
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  const getSession = options.getSession ?? (() => authClient.getSession())
  const appRouter = createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: "/",
        name: "home",
        component: HomeView,
      },
      {
        path: "/login",
        name: "login",
        component: LoginView,
      },
      {
        path: "/security/audit-log",
        name: "audit-log",
        component: AuditLogView,
      },
      {
        path: "/security/authorized-apps",
        name: "authorized-apps",
        component: AuthorizedAppsView,
      },
      {
        path: "/:pathMatch(.*)*",
        name: "not-found",
        component: NotFoundView,
      },
    ],
    scrollBehavior(_to, _from, savedPosition) {
      return savedPosition ?? { top: 0 }
    },
    strict: true,
  })

  appRouter.beforeEach(async (to) => {
    let authenticationState: "authenticated" | "unauthenticated" | "unknown" =
      "unknown"

    try {
      const result = await getSession()
      if (result.data?.session) {
        authenticationState = "authenticated"
      } else if (result.error == null) {
        authenticationState = "unauthenticated"
      }
    } catch {
      // Preserve the requested route so its own retry UI remains available.
    }

    if (to.name !== "login" && authenticationState === "unauthenticated") {
      return { name: "login" }
    }

    if (to.name === "login" && authenticationState === "authenticated") {
      return { name: "home" }
    }
  })

  appRouter.afterEach(async (_to, _from, failure) => {
    if (failure) return

    await nextTick()
    document
      .querySelector<HTMLElement>("[data-route-heading]")
      ?.focus({ preventScroll: true })
  })

  return appRouter
}

export const router = createAppRouter()
