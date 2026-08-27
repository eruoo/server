import { Hono } from "hono"

import { inspectCredentialCarriers } from "../auth/carriers"
import { problem } from "../http/problem"
import {
  isProblemSlug,
  problemTypeRegistry,
  problemTypeUri,
} from "../http/problem-registry"
import type { AppBindings } from "../http/types"

export const problemsRouter = new Hono<AppBindings>({ strict: true })

problemsRouter.get("/problems/:slug", (context) => {
  const inspection = inspectCredentialCarriers(context.req.raw)

  if (
    inspection.invalid ||
    inspection.carriers.some((carrier) => carrier !== "session")
  ) {
    return problem(context, {
      detail:
        "Problem type documentation does not accept explicit credentials.",
      slug: "invalid-request",
    })
  }

  const slug = context.req.param("slug")
  if (!isProblemSlug(slug)) {
    return context.body(null, 404, { "Cache-Control": "no-store" })
  }

  const definition = problemTypeRegistry[slug]
  return context.json(
    {
      description: definition.description,
      status: definition.status,
      title: definition.title,
      type: problemTypeUri(slug),
    },
    200,
    { "Cache-Control": "no-store" },
  )
})
