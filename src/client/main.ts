import App from "@client/App.vue"
import { initializeTheme } from "@client/composables/useTheme"
import { router } from "@client/router"
import { createApp } from "vue"

import "@client/styles/main.css"

initializeTheme()

createApp(App).use(router).mount("#app")
