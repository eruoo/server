import process from "node:process"
import { Elysia } from "elysia"
import { modules } from "./modules"
import { openapiPlugin } from "./plugins"

const apis = new Elysia({
  prefix: "/api",
}).use(modules)

const app = new Elysia()
  .use(openapiPlugin)
  .use(apis)
  .get("/", () => "Hello Eruoo Server!")
  .listen(process.env.PORT ?? 3000)

// eslint-disable-next-line no-console
console.log(
  `🚀 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`,
)
