import { openapi } from "@elysiajs/openapi"
import { Elysia } from "elysia"
import { OpenAPI } from "@/modules/auth/auth"

export const openapiPlugin = new Elysia({
  name: "openapi-plugin",
}).use(async () =>
  openapi({
    documentation: {
      components: await OpenAPI.components,
      paths: await OpenAPI.getPaths(),
    },
  }),
)
