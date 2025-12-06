import { Elysia } from "elysia"
import { authModule } from "./auth"

export const modules = new Elysia().use(authModule)
