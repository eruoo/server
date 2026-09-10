import { createRouter, createWebHistory } from "vue-router"

import HomeView from "./views/HomeView.vue"
import LoginView from "./views/LoginView.vue"
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/oauth/consent",
      component: () => import("./views/OAuthConsentView.vue"),
    },
    {
      path: "/security/authorized-apps",
      component: () => import("./views/OAuthView.vue"),
    },
    { path: "/api/docs", component: () => import("./views/ApiDocsView.vue") },
    {
      path: "/security/api-keys",
      component: () => import("./views/ApiKeysView.vue"),
    },
    { path: "/", redirect: "/security/passkeys" },
    { path: "/account", component: HomeView },
    {
      path: "/security/passkeys",
      component: () => import("./views/PasskeysView.vue"),
    },
    {
      path: "/security/audit-log",
      component: () => import("./views/AuditView.vue"),
    },
    { path: "/login", component: LoginView },
    {
      path: "/:pathMatch(.*)*",
      component: () => import("./views/NotFoundView.vue"),
    },
  ],
})
