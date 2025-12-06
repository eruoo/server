import process from "node:process"
import { cors } from "@elysiajs/cors"
import Elysia from "elysia"

export const corsPlugin = new Elysia({
  name: "cors-plugin",
}).use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)
