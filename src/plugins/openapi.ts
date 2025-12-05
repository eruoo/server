import { openapi } from "@elysiajs/openapi"
import { Elysia } from "elysia"

export const openapiPlugin = new Elysia().use(openapi())
