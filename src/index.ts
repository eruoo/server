import process from "node:process"
import { Elysia } from "elysia"

const app = new Elysia({
  prefix: "/api",
})
  .get("/", () => "Hello Eruoo Server!")
  .listen(process.env.PORT ?? 3000)

// eslint-disable-next-line no-console
console.log(
  `🚀 Elysia is running at http://${app.server?.hostname}:${app.server?.port}${app.config.prefix}`,
)
